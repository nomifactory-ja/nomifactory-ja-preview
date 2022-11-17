import * as vscode from "vscode";

/**
 * Change the top-most visible line of `editor` to be at `line`
 */
export function scrollEditorToLine(line: number, editor: vscode.TextEditor) {
  const revealRange = toRevealRange(line, editor);
  editor.revealRange(revealRange, vscode.TextEditorRevealType.AtTop);
}

function toRevealRange(line: number, editor: vscode.TextEditor): vscode.Range {
  // if (line < 0) {
  //   line = 0;
  // }
  const sourceLine = Math.floor(line);
  if (sourceLine >= editor.document.lineCount) {
    return new vscode.Range(editor.document.lineCount - 1, 0, editor.document.lineCount - 1, 0);
  }

  const fraction = line - sourceLine;
  const text = editor.document.lineAt(sourceLine).text;
  const start = Math.floor(fraction * text.length);
  return new vscode.Range(sourceLine, start, sourceLine + 1, 0);
}

export class StartingScrollFragment {
  public readonly type = "fragment";

  constructor(public readonly fragment: string) {}
}

export class StartingScrollLine {
  public readonly type = "line";

  constructor(public readonly line: number) {}
}

export type StartingScrollLocation = StartingScrollLine | StartingScrollFragment;
