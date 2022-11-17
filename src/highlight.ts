import {Tree, NodeType} from "@lezer/common"
import {Tag, tags, tagHighlighter, Highlighter, highlightTree} from "@lezer/highlight"
import {StyleSpec, StyleModule} from "style-mod"
import {EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet} from "@codemirror/view"
import {EditorState, Prec, Facet, Extension, RangeSetBuilder} from "@codemirror/state"
import {syntaxTree, Language, languageDataProp} from "./language"

/// A highlight style associates CSS styles with higlighting
/// [tags](https://lezer.codemirror.net/docs/ref#highlight.Tag).
export class HighlightStyle implements Highlighter {
  /// A style module holding the CSS rules for this highlight style.
  /// When using
  /// [`highlightTree`](https://lezer.codemirror.net/docs/ref#highlight.highlightTree)
  /// outside of the editor, you may want to manually mount this
  /// module to show the highlighting.
  readonly module: StyleModule | null

  /// @internal
  readonly themeType: "dark" | "light" | undefined

  readonly style: (tags: readonly Tag[]) => string | null
  readonly scope: ((type: NodeType) => boolean) | undefined

  private constructor(
    /// The tag styles used to create this highlight style.
    readonly specs: readonly TagStyle[],
    options: {scope?: NodeType | Language, all?: string | StyleSpec, themeType?: "dark" | "light"}
  ) {
    let modSpec: {[name: string]: StyleSpec} | undefined
    function def(spec: StyleSpec) {
      let cls = StyleModule.newName()
      ;(modSpec || (modSpec = Object.create(null)))["." + cls] = spec
      return cls
    }

    const all = typeof options.all == "string" ? options.all : options.all ? def(options.all) : undefined

    const scopeOpt = options.scope
    this.scope = scopeOpt instanceof Language ? (type: NodeType) => type.prop(languageDataProp) == scopeOpt.data
      : scopeOpt ? (type: NodeType) => type == scopeOpt : undefined

    this.style = tagHighlighter(specs.map(style => ({
      tag: style.tag,
      class: style.class as string || def(Object.assign({}, style, {tag: null}))
    })), {
      all,
    }).style

    this.module = modSpec ? new StyleModule(modSpec) : null
    this.themeType = options.themeType
  }

  /// Create a highlighter style that associates the given styles to
  /// the given tags. The specs must be objects that hold a style tag
  /// or array of tags in their `tag` property, and either a single
  /// `class` property providing a static CSS class (for highlighter
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
    /// scope them to a single language by providing the language
    /// object or a language's top node type here.
    scope?: Language | NodeType,
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

const highlighterFacet = Facet.define<Highlighter>()

const fallbackHighlighter = Facet.define<Highlighter, readonly Highlighter[] | null>({
  combine(values) { return values.length ? [values[0]] : null }
})

function getHighlighters(state: EditorState): readonly Highlighter[] | null {
  let main = state.facet(highlighterFacet)
  return main.length ? main : state.facet(fallbackHighlighter)
}

/// Wrap a highlighter in an editor extension that uses it to apply
/// syntax highlighting to the editor content.
///
/// When multiple (non-fallback) styles are provided, the styling
/// applied is the union of the classes they emit.
export function syntaxHighlighting(highlighter: Highlighter, options?: {
  /// When enabled, this marks the highlighter as a fallback, which
  /// only takes effect if no other highlighters are registered.
  fallback: boolean
}): Extension {
  let ext: Extension[] = [treeHighlighter], themeType: string | undefined
  if (highlighter instanceof HighlightStyle) {
    if (highlighter.module) ext.push(EditorView.styleModule.of(highlighter.module))
    themeType = highlighter.themeType
  }
  if (options?.fallback)
    ext.push(fallbackHighlighter.of(highlighter))
  else if (themeType)
    ext.push(highlighterFacet.computeN([EditorView.darkTheme], state => {
      return state.facet(EditorView.darkTheme) == (themeType == "dark") ? [highlighter] : []
    }))
  else
    ext.push(highlighterFacet.of(highlighter))
  return ext
}

/// Returns the CSS classes (if any) that the highlighters active in
/// the state would assign to the given style
/// [tags](https://lezer.codemirror.net/docs/ref#highlight.Tag) and
/// (optional) language
/// [scope](#language.HighlightStyle^define^options.scope).
export function highlightingFor(state: EditorState, tags: readonly Tag[], scope?: NodeType): string | null {
  let highlighters = getHighlighters(state)
  let result = null
  if (highlighters) for (let highlighter of highlighters) {
    if (!highlighter.scope || scope && highlighter.scope(scope)) {
      let cls = highlighter.style(tags)
      if (cls) result = result ? result + " " + cls : cls
    }
  }
  return result
}

/// The type of object used in
/// [`HighlightStyle.define`](#language.HighlightStyle^define).
/// Assigns a style to one or more highlighting
/// [tags](https://lezer.codemirror.net/docs/ref#highlight.Tag), which can either be a fixed class name
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
  /// (The type here is `any` because of TypeScript limitations.)
  [styleProperty: string]: any
}

class TreeHighlighter {
  decorations: DecorationSet
  tree: Tree
  markCache: {[cls: string]: Decoration} = Object.create(null)

  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state)
    this.decorations = this.buildDeco(view, getHighlighters(view.state))
  }

  update(update: ViewUpdate) {
    let tree = syntaxTree(update.state), highlighters = getHighlighters(update.state)
    let styleChange = highlighters != getHighlighters(update.startState)
    if (tree.length < update.view.viewport.to && !styleChange && tree.type == this.tree.type) {
      this.decorations = this.decorations.map(update.changes)
    } else if (tree != this.tree || update.viewportChanged || styleChange) {
      this.tree = tree
      this.decorations = this.buildDeco(update.view, highlighters)
    }
  }

  buildDeco(view: EditorView, highlighters: readonly Highlighter[] | null) {
    if (!highlighters || !this.tree.length) return Decoration.none

    let builder = new RangeSetBuilder<Decoration>()
    for (let {from, to} of view.visibleRanges) {
      highlightTree(this.tree, highlighters, (from, to, style) => {
        builder.add(from, to, this.markCache[style] || (this.markCache[style] = Decoration.mark({class: style})))
      }, from, to)
    }
    return builder.finish()
  }
}

const treeHighlighter = Prec.high(ViewPlugin.fromClass(TreeHighlighter, {
  decorations: v => v.decorations
}))

/// A default highlight style (works well with light themes).
export const defaultHighlightStyle = HighlightStyle.define([
  {tag: tags.meta,
   color: "#404740"},
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
