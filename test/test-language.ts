import ist from "ist"
import {LRLanguage, syntaxTree} from "@codemirror/language"
import {EditorState} from "@codemirror/state"
import {parser} from "@lezer/javascript"

describe("LRLanguage", () => {
  it("parses the document", () => {
    let lang = LRLanguage.define({name: "js", parser})
    let state = EditorState.create({doc: "x = 2", extensions: lang})
    ist(syntaxTree(state).topNode.name, "Script")
  })

  it("can be reconfigured", () => {
    let lang = LRLanguage.define({name: "js", parser})
    let lang2 = lang.configure({dialect: "jsx"})
    let state = EditorState.create({doc: "x = <foo/>", extensions: lang2})
    ist(syntaxTree(state).resolve(6).name, "JSXIdentifier")
  })

  it("associates language data", () => {
    let lang = LRLanguage.define({name: "js", parser, languageData: {foo: 22}})
    let state = EditorState.create({extensions: lang})
    ist(state.languageDataAt("foo", 0).join(","), "22")
  })

  it("can reconfigure associated language data", () => {
    let lang = LRLanguage.define({name: "js", parser, languageData: {foo: 22, bar: 10}})
    let lang2 = lang.configure({languageData: {foo: undefined, baz: 11}})
    let state = EditorState.create({extensions: lang2})
    ist(state.languageDataAt("foo", 0).length, 0)
    ist(state.languageDataAt("bar", 0).join(","), "10")
    ist(state.languageDataAt("baz", 0).join(","), "11")
  })
})
