import {Tree, NodeType} from "@lezer/common"
import {Tag, tags, tagHighlighter, combinedHighlighter, Highlighter, highlightTree} from "@lezer/highlight"
import {StyleSpec, StyleModule} from "style-mod"
import {EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet} from "@codemirror/view"
import {EditorState, Prec, Facet, Extension} from "@codemirror/state"
import {syntaxTree} from "@codemirror/language"
import {RangeSetBuilder} from "@codemirror/rangeset"

/// A highlight style associates CSS styles with higlighting
/// [tags](#highlight.Tag).
export class HighlightStyle {
  /// A style module holding the CSS rules for this highlight style.
  /// When using [`highlightTree`](#highlight.highlightTree), you may
  /// want to manually mount this module to show the highlighting.
  readonly module: StyleModule | null

  /// Returns the CSS classes associated with the given tags, if any.
  /// This is a stand-alone function value, and can be passed to
  /// `highlighTree` without binding it.
  readonly highlighter: Highlighter

  /// @internal
  readonly themeType: "dark" | "light" | undefined

  private constructor(spec: readonly TagStyle[],
                      options: {scope?: NodeType, all?: string | StyleSpec, themeType?: "dark" | "light"}) {
    let modSpec: {[name: string]: StyleSpec} | undefined
    function def(spec: StyleSpec) {
      let cls = StyleModule.newName()
      ;(modSpec || (modSpec = Object.create(null)))["." + cls] = spec
      return cls
    }

    this.highlighter = tagHighlighter(spec.map(style => ({
      tag: style.tag,
      class: style.class as string || def(Object.assign({}, style, {tag: null}))
    })), {
      scope: options.scope,
      all: typeof options.all == "string" ? options.all : options.all ? def(options.all) : undefined,
    })

    this.module = modSpec ? new StyleModule(modSpec) : null
    this.themeType = options.themeType
  }

  /// Create a highlighter style that associates the given styles to
  /// the given tags. The spec must be objects that hold a style tag
  /// or array of tags in their `tag` property, and either a single
  /// `class` property providing a static CSS class (for highlighters
  /// like [`classHighlightStyle`](#highlight.classHighlightStyle)
  /// that rely on external styling), or a
  /// [`style-mod`](https://github.com/marijnh/style-mod#documentation)-style
  /// set of CSS properties (which define the styling for those tags).
  ///
  /// The CSS rules created for a highlighter will be emitted in the
  /// order of the spec's properties. That means that for elements that
  /// have multiple tags associated with them, styles defined further
  /// down in the list will have a higher CSS precedence than styles
  /// defined earlier.
  static define(specs: readonly TagStyle[], options?: {
    /// By default, highlighters apply to the entire document. You can
    /// scope them to a single language by providing the language's
    /// [top node](#language.Language.topNode) here.
    scope?: NodeType,
    /// Add a style to _all_ content. Probably only useful in
    /// combination with `scope`.
    all?: string | StyleSpec,
    /// Specify that this highlight style should only be active then
    /// the theme is dark or light. By default, it is active
    /// regardless of theme.
    themeType?: "dark" | "light"
  }) {
    return new HighlightStyle(specs, options || {})
  }
}

const highlighterFacet = Facet.define<Highlighter, Highlighter | null>({
  combine(highlighters) { return highlighters.length ? combinedHighlighter(highlighters) : null }
})

const fallbackHighlighter = Facet.define<Highlighter, Highlighter | null>({
  combine(values) { return values.length ? values[0] : null }
})

function getHighlighter(state: EditorState): Highlighter | null {
  return state.facet(highlighterFacet) || state.facet(fallbackHighlighter)
}

export function syntaxHighlighting(highlighter: Highlighter | HighlightStyle, options?: {fallback: boolean}): Extension {
  let ext: Extension[] = [treeHighlighter]
  let [mod, hl, themeType] = highlighter instanceof HighlightStyle
    ? [highlighter.module, highlighter.highlighter, highlighter.themeType]
    : [null, highlighter, undefined]
  if (mod) ext.push(EditorView.styleModule.of(mod))
  if (options?.fallback)
    ext.push(fallbackHighlighter.of(hl))
  else if (themeType)
    ext.push(highlighterFacet.computeN([EditorView.darkTheme], state => {
      return state.facet(EditorView.darkTheme) == (themeType == "dark") ? [hl] : []
    }))
  else
    ext.push(highlighterFacet.of(hl))
  return ext
}

/// Returns the CSS classes (if any) that the highlighters active in
/// the given state would assign to the given a style
/// [tags](#highlight.Tag) and (optional) language
/// [scope](#highlight.HighlightStyle^define^options.scope).
export function highlightingFor(state: EditorState, tags: readonly Tag[], scope?: NodeType) {
  let style = getHighlighter(state)
  return style && style(tags, scope || NodeType.none)
}

/// The type of object used in
/// [`HighlightStyle.define`](#highlight.HighlightStyle^define).
/// Assigns a style to one or more highlighting
/// [tags](#highlight.Tag), which can either be a fixed class name
/// (which must be defined elsewhere), or a set of CSS properties, for
/// which the library will define an anonymous class.
export interface TagStyle {
  /// The tag or tags to target.
  tag: Tag | readonly Tag[],
  /// If given, this maps the tags to a fixed class name.
  class?: string,
  /// Any further properties (if `class` isn't given) will be
  /// interpreted as in style objects given to
  /// [style-mod](https://github.com/marijnh/style-mod#documentation).
  /// The type here is `any` because of TypeScript limitations.
  [styleProperty: string]: any
}

class TreeHighlighter {
  decorations: DecorationSet
  tree: Tree
  markCache: {[cls: string]: Decoration} = Object.create(null)

  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state)
    this.decorations = this.buildDeco(view, getHighlighter(view.state))
  }

  update(update: ViewUpdate) {
    let tree = syntaxTree(update.state), style = getHighlighter(update.state)
    let styleChange = style != getHighlighter(update.startState)
    if (tree.length < update.view.viewport.to && !styleChange && tree.type == this.tree.type) {
      this.decorations = this.decorations.map(update.changes)
    } else if (tree != this.tree || update.viewportChanged || styleChange) {
      this.tree = tree
      this.decorations = this.buildDeco(update.view, style)
    }
  }

  buildDeco(view: EditorView, highlighter: Highlighter | null) {
    if (!highlighter || !this.tree.length) return Decoration.none

    let builder = new RangeSetBuilder<Decoration>()
    for (let {from, to} of view.visibleRanges) {
      highlightTree(this.tree, highlighter, (from, to, style) => {
        builder.add(from, to, this.markCache[style] || (this.markCache[style] = Decoration.mark({class: style})))
      }, from, to)
    }
    return builder.finish()
  }
}

// This extension installs a highlighter that highlights based on the
// syntax tree and highlight style.
const treeHighlighter = Prec.high(ViewPlugin.fromClass(TreeHighlighter, {
  decorations: v => v.decorations
}))

/// A default highlight style (works well with light themes).
export const defaultHighlightStyle = HighlightStyle.define([
  {tag: tags.meta,
   color: "#7a757a"},
  {tag: tags.link,
   textDecoration: "underline"},
  {tag: tags.heading,
   textDecoration: "underline",
   fontWeight: "bold"},
  {tag: tags.emphasis,
   fontStyle: "italic"},
  {tag: tags.strong,
   fontWeight: "bold"},
  {tag: tags.strikethrough,
   textDecoration: "line-through"},
  {tag: tags.keyword,
   color: "#708"},
  {tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName],
   color: "#219"},
  {tag: [tags.literal, tags.inserted],
   color: "#164"},
  {tag: [tags.string, tags.deleted],
   color: "#a11"},
  {tag: [tags.regexp, tags.escape, tags.special(tags.string)],
   color: "#e40"},
  {tag: tags.definition(tags.variableName),
   color: "#00f"},
  {tag: tags.local(tags.variableName),
   color: "#30a"},
  {tag: [tags.typeName, tags.namespace],
   color: "#085"},
  {tag: tags.className,
   color: "#167"},
  {tag: [tags.special(tags.variableName), tags.macroName],
   color: "#256"},
  {tag: tags.definition(tags.propertyName),
   color: "#00c"},
  {tag: tags.comment,
   color: "#940"},
  {tag: tags.invalid,
   color: "#f00"}
])
