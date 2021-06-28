import {Tree, TreeFragment, NodeType, NodeSet, SyntaxNode, PartialParse, Parser,
        ParseSpec, FullParseSpec, NodeProp} from "@lezer/common"
import {Tag, tags, styleTags} from "@codemirror/highlight"
import {Language, defineLanguageFacet, languageDataProp, IndentContext, indentService,
        getIndentUnit, syntaxTree, ParseContext} from "@codemirror/language"
import {EditorState, Facet} from "@codemirror/state"
import {StringStream} from "./stringstream"

export {StringStream}

/// A stream parser parses or tokenizes content from start to end,
/// emitting tokens as it goes over it. It keeps a mutable (but
/// copyable) object with state, in which it can store information
/// about the current context.
export interface StreamParser<State> {
  /// Read one token, advancing the stream past it, and returning a
  /// string indicating the token's style tag—either the name of one
  /// of the tags in [`tags`](#highlight.tags), or such a name
  /// suffixed by one or more tag
  /// [modifier](#highlight.Tag^defineModifier) names, separated by
  /// spaces. For example `"keyword"` or "`variableName.constant"`.
  ///
  /// It is okay to return a zero-length token, but only if that
  /// updates the state so that the next call will return a non-empty
  /// token again.
  token(stream: StringStream, state: State): string | null
  /// This notifies the parser of a blank line in the input. It can
  /// update its state here if it needs to.
  blankLine?(state: State, indentUnit: number): void
  /// Produce a start state for the parser.
  startState?(indentUnit: number): State
  /// Copy a given state. By default, a shallow object copy is done
  /// which also copies arrays held at the top level of the object.
  copyState?(state: State): State
  /// Compute automatic indentation for the line that starts with the
  /// given state and text.
  indent?(state: State, textAfter: string, context: IndentContext): number | null
  /// Default [language data](#state.EditorState.languageDataAt) to
  /// attach to this language.
  languageData?: {[name: string]: any}
}

function fullParser<State>(spec: StreamParser<State>): Required<StreamParser<State>> {
  return {
    token: spec.token,
    blankLine: spec.blankLine || (() => {}),
    startState: spec.startState || (() => (true as any)),
    copyState: spec.copyState || defaultCopyState,
    indent: spec.indent || (() => null),
    languageData: spec.languageData || {}
  }
}

function defaultCopyState<State>(state: State) {
  if (typeof state != "object") return state
  let newState = {} as State
  for (let prop in state) {
    let val = state[prop]
    newState[prop] = (val instanceof Array ? val.slice() : val) as any
  }
  return newState
}

/// A [language](#language.Language) class based on a streaming
/// parser.
export class StreamLanguage<State> extends Language {
  /// @internal
  streamParser: Required<StreamParser<State>>
  /// @internal
  stateAfter: NodeProp<State>

  private constructor(parser: StreamParser<State>) {
    let data = defineLanguageFacet(parser.languageData)
    let p = fullParser(parser), self: StreamLanguage<State>
    let impl = new class extends Parser {
      startParse(spec: ParseSpec) { return new Parse(self, new FullParseSpec(spec)) }
    }
    super(data, impl, docID(data), [indentService.of((cx, pos) => this.getIndent(cx, pos))])
    self = this
    this.streamParser = p
    this.stateAfter = new NodeProp<State>({perNode: true})
  }

  static define<State>(spec: StreamParser<State>) { return new StreamLanguage(spec) }

  private getIndent(cx: IndentContext, pos: number) {
    let tree = syntaxTree(cx.state), at: SyntaxNode | null = tree.resolve(pos)
    while (at && at.type != this.topNode) at = at.parent
    if (!at) return null
    let start = findState(this, tree, 0, at.from, pos), statePos, state
    if (start) { state = start.state; statePos = start.pos + 1 }
    else { state = this.streamParser.startState(cx.unit) ; statePos = 0 }
    if (pos - statePos > C.MaxIndentScanDist) return null
    while (statePos < pos) {
      let line = cx.state.doc.lineAt(statePos), end = Math.min(pos, line.to)
      if (line.length) {
        let stream = new StringStream(line.text, cx.state.tabSize, cx.unit)
        while (stream.pos < end - line.from)
          readToken(this.streamParser.token, stream, state)
      } else {
        this.streamParser.blankLine(state, cx.unit)
      }
      if (end == pos) break
      statePos = line.to + 1
    }
    let {text} = cx.state.doc.lineAt(pos)
    return this.streamParser.indent(state, /^\s*(.*)/.exec(text)![1], cx)
  }

  get allowsNesting() { return false }
}

function findState<State>(
  lang: StreamLanguage<State>, tree: Tree, off: number, startPos: number, before: number
): {state: State, pos: number} | null {
  let state = off >= startPos && off + tree.length <= before && tree.prop(lang.stateAfter)
  if (state) return {state: lang.streamParser.copyState(state), pos: off + tree.length}
  for (let i = tree.children.length - 1; i >= 0; i--) {
    let child = tree.children[i], pos = off + tree.positions[i]
    let found = child instanceof Tree && pos < before && findState(lang, child, pos, startPos, before)
    if (found) return found
  }
  return null
}

function cutTree(lang: StreamLanguage<unknown>, tree: Tree, from: number, to: number, inside: boolean): Tree | null {
  if (inside && from <= 0 && to >= tree.length) return tree
  if (!inside && tree.type == lang.topNode) inside = true
  for (let i = tree.children.length - 1; i >= 0; i--) {
    let pos = tree.positions[i] + from, child = tree.children[i], inner
    if (pos < to && child instanceof Tree) {
      if (!(inner = cutTree(lang, child, from - pos, to - pos, inside))) break
      return !inside ? inner
        : new Tree(tree.type, tree.children.slice(0, i).concat(inner), tree.positions.slice(0, i + 1), pos + inner.length)
    }
  }
  return null
}

function findStartInFragments<State>(lang: StreamLanguage<State>, fragments: readonly TreeFragment[],
                                     startPos: number, editorState?: EditorState) {
  for (let f of fragments) {
    let found = f.from <= startPos && f.to > startPos && findState(lang, f.tree, 0 - f.offset, startPos, f.to), tree
    if (found && (tree = cutTree(lang, f.tree, startPos + f.offset, found.pos + f.offset, false)))
      return {state: found.state, tree}
  }
  return {state: lang.streamParser.startState(editorState ? getIndentUnit(editorState) : 4), tree: Tree.empty}
}

const enum C {
  ChunkSize = 2048,
  MaxDistanceBeforeViewport = 1e5,
  MaxIndentScanDist = 1e4
}

class Parse<State> implements PartialParse {
  state: State
  parsedPos: number
  stoppedAt: number | null = null
  chunks: Tree[] = []
  chunkPos: number[] = []
  chunkStart: number
  chunk: number[] = []

  constructor(readonly lang: StreamLanguage<State>,
              readonly spec: FullParseSpec) {
    let context = ParseContext.get()
    let {state, tree} = findStartInFragments(lang, spec.fragments, spec.from, context?.state)
    this.state = state
    this.parsedPos = this.chunkStart = spec.from + tree.length
    if (tree.length) {
      this.chunks.push(tree)
      this.chunkPos.push(0)
    }
    if (context && this.parsedPos < context.viewport.from - C.MaxDistanceBeforeViewport) {
      this.state = this.lang.streamParser.startState(getIndentUnit(context.state))
      context.skipUntilInView(this.parsedPos, context.viewport.from)
      this.parsedPos = context.viewport.from
    }
  }

  advance() {
    let context = ParseContext.get()
    let parseEnd = this.stoppedAt == null ? this.spec.to : this.stoppedAt
    let end = Math.min(parseEnd, this.chunkStart + C.ChunkSize)
    if (context) end = Math.min(end, context.viewport.to)
    while (this.parsedPos < end) this.parseLine(context)
    if (this.chunkStart < this.parsedPos) this.finishChunk()
    if (this.parsedPos >= parseEnd) return this.finish()
    if (context && this.parsedPos > context.viewport.to) {
      context.skipUntilInView(this.parsedPos, parseEnd)
      return this.finish()
    }
    return null
  }

  stopAt(pos: number) {
    this.stoppedAt = pos
  }

  lineAfter(pos: number) {
    let chunk = this.spec.input.chunk(pos)
    if (!this.spec.input.lineChunks) {
      let eol = chunk.indexOf("\n")
      if (eol > -1) chunk = chunk.slice(0, eol)
    } else if (chunk == "\n") {
      chunk = ""
    }
    return pos + chunk.length <= this.spec.to ? chunk : chunk.slice(0, this.spec.to - pos)
  }

  parseLine(context: ParseContext | null) {
    let line = this.lineAfter(this.parsedPos), {streamParser} = this.lang
    let stream = new StringStream(line, context ? context.state.tabSize : 4, context ? getIndentUnit(context.state) : 2)
    if (stream.eol()) {
      streamParser.blankLine(this.state, stream.indentUnit)
    } else {
      while (!stream.eol()) {
        let token = readToken(streamParser.token, stream, this.state)
        if (token)
          this.chunk.push(tokenID(token), this.parsedPos + stream.start, this.parsedPos + stream.pos, 4)
      }
    }
    this.parsedPos += line.length
    if (this.parsedPos < this.spec.to) this.parsedPos++
  }

  finishChunk() {
    let tree = Tree.build({
      buffer: this.chunk,
      start: this.chunkStart,
      length: this.parsedPos - this.chunkStart,
      nodeSet,
      topID: 0,
      maxBufferLength: C.ChunkSize
    })
    tree = new Tree(tree.type, tree.children, tree.positions, tree.length,
                    [[this.lang.stateAfter, this.lang.streamParser.copyState(this.state)]])
    this.chunks.push(tree)
    this.chunkPos.push(this.chunkStart - this.spec.from)
    this.chunk = []
    this.chunkStart = this.parsedPos
  }

  finish() {
    return new Tree(this.lang.topNode, this.chunks, this.chunkPos, this.parsedPos - this.spec.from).balance()
  }
}

function readToken<State>(token: (stream: StringStream, state: State) => string | null,
                          stream: StringStream, state: State) {
  stream.start = stream.pos
  for (let i = 0; i < 10; i++) {
    let result = token(stream, state)
    if (stream.pos > stream.start) return result
  }
  throw new Error("Stream parser failed to advance stream.")
}

const tokenTable: {[name: string]: number} = Object.create(null)
const typeArray: NodeType[] = [NodeType.none]
const nodeSet = new NodeSet(typeArray)
const warned: string[] = []

function tokenID(tag: string): number {
  return !tag ? 0 : tokenTable[tag] || (tokenTable[tag] = createTokenType(tag))
}

for (let [legacyName, name] of [
  ["variable", "variableName"],
  ["variable-2", "variableName.special"],
  ["string-2", "string.special"],
  ["def", "variableName.definition"],
  ["tag", "typeName"],
  ["attribute", "propertyName"],
  ["type", "typeName"],
  ["builtin", "variableName.standard"],
  ["qualifier", "modifier"],
  ["error", "invalid"],
  ["header", "heading"],
  ["property", "propertyName"]
]) tokenTable[legacyName] = tokenID(name)

function warnForPart(part: string, msg: string) {
  if (warned.indexOf(part) > -1) return
  warned.push(part)
  console.warn(msg)
}

function createTokenType(tagStr: string) {
  let tag = null
  for (let part of tagStr.split(".")) {
    let value = (tags as any)[part]
    if (!value) {
      warnForPart(part, `Unknown highlighting tag ${part}`)
    } else if (typeof value == "function") {
      if (!tag) warnForPart(part, `Modifier ${part} used at start of tag`)
      else tag = value(tag) as Tag
    } else {
      if (tag) warnForPart(part, `Tag ${part} used as modifier`)
      else tag = value as Tag
    }
  }
  if (!tag) return 0

  let name = tagStr.replace(/ /g, "_"), type = NodeType.define({
    id: typeArray.length,
    name,
    props: [styleTags({[name]: tag})]
  })
  typeArray.push(type)
  return type.id
}

function docID(data: Facet<{[name: string]: any}>) {
  let type = NodeType.define({id: typeArray.length, name: "Document", props: [languageDataProp.add(() => data)]})
  typeArray.push(type)
  return type
}
