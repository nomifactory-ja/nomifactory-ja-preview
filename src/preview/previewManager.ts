import * as vscode from "vscode";
import { Disposable, disposeAll } from "../util/dispose";
import { isLanguageFile } from "../util/file";
import { TopmostLineMonitor } from "./topmostLineMonitor";
import { DynamicPreview, IManagedPreview, StaticPreview } from "./preview";
import { Renderer } from "./renderer";
import { scrollEditorToLine, StartingScrollFragment } from "./scrolling";
import { LangContributionProvider } from "../langExtensions";
import { ILogger } from "../logging";

export interface DynamicPreviewSettings {
  readonly resourceColumn: vscode.ViewColumn;
  readonly previewColumn: vscode.ViewColumn;
  readonly locked: boolean;
}

class PreviewStore<T extends IManagedPreview> extends Disposable {
  private readonly _previews = new Set<T>();

  public override dispose(): void {
    super.dispose();
    for (const preview of this._previews) {
      preview.dispose();
    }
    this._previews.clear();
  }

  [Symbol.iterator](): Iterator<T> {
    return this._previews[Symbol.iterator]();
  }

  public get(resource: vscode.Uri, previewSettings: DynamicPreviewSettings): T | undefined {
    const previewColumn = this._resolvePreviewColumn(previewSettings);
    for (const preview of this._previews) {
      if (preview.matchesResource(resource, previewColumn, previewSettings.locked)) {
        return preview;
      }
    }
    return undefined;
  }

  public add(preview: T) {
    this._previews.add(preview);
  }

  public delete(preview: T) {
    this._previews.delete(preview);
  }

  private _resolvePreviewColumn(previewSettings: DynamicPreviewSettings): vscode.ViewColumn | undefined {
    if (previewSettings.previewColumn === vscode.ViewColumn.Active) {
      return vscode.window.tabGroups.activeTabGroup.viewColumn;
    }

    if (previewSettings.previewColumn === vscode.ViewColumn.Beside) {
      return vscode.window.tabGroups.activeTabGroup.viewColumn + 1;
    }

    return previewSettings.previewColumn;
  }
}

export class PreviewManager extends Disposable implements vscode.WebviewPanelSerializer, vscode.CustomTextEditorProvider {
  private readonly _topmostLineMonitor = new TopmostLineMonitor();
  // private readonly _previewConfigurations = new MarkdownPreviewConfigurationManager();

  private readonly _dynamicPreviews = this._register(new PreviewStore<DynamicPreview>());
  private readonly _staticPreviews = this._register(new PreviewStore<StaticPreview>());

  private _activePreview: IManagedPreview | undefined = undefined;

  public constructor(
    private readonly _contentProvider: Renderer,
    private readonly _contributions: LangContributionProvider, // private readonly _opener: MdLinkOpener
    private readonly _logger: ILogger
  ) {
    super();

    this._register(vscode.window.registerWebviewPanelSerializer(DynamicPreview.viewType, this));

    this._register(
      vscode.window.registerCustomEditorProvider(StaticPreview.customEditorViewType, this, {
        webviewOptions: { enableFindWidget: true },
      })
    );

    this._register(
      vscode.window.onDidChangeActiveTextEditor((textEditor) => {
        // When at a markdown file, apply existing scroll settings
        if (textEditor?.document && isLanguageFile(textEditor.document)) {
          const line = this._topmostLineMonitor.getPreviousStaticEditorLineByUri(textEditor.document.uri);
          if (typeof line === "number") {
            scrollEditorToLine(line, textEditor);
          }
        }
      })
    );
  }

  public refresh() {
    for (const preview of this._dynamicPreviews) {
      preview.refresh();
    }
    for (const preview of this._staticPreviews) {
      preview.refresh();
    }
  }

  // public updateConfiguration() {
  //   for (const preview of this._dynamicPreviews) {
  //     preview.updateConfiguration();
  //   }
  //   for (const preview of this._staticPreviews) {
  //     preview.updateConfiguration();
  //   }
  // }

  public openDynamicPreview(resource: vscode.Uri, settings: DynamicPreviewSettings): void {
    let preview = this._dynamicPreviews.get(resource, settings);
    if (preview) {
      preview.reveal(settings.previewColumn);
    } else {
      preview = this._createNewDynamicPreview(resource, settings);
    }

    preview?.update(resource, resource.fragment ? new StartingScrollFragment(resource.fragment) : undefined);
  }

  public get activePreviewResource() {
    return this._activePreview?.resource;
  }

  public get activePreviewResourceColumn() {
    return this._activePreview?.resourceColumn;
  }

  public toggleLock() {
    const preview = this._activePreview;
    if (preview instanceof DynamicPreview) {
      preview.toggleLock();

      // Close any previews that are now redundant, such as having two dynamic previews in the same editor group
      for (const otherPreview of this._dynamicPreviews) {
        if (otherPreview !== preview && preview.matches(otherPreview)) {
          otherPreview.dispose();
        }
      }
    }
  }

  public async deserializeWebviewPanel(webview: vscode.WebviewPanel, state: any): Promise<void> {
    try {
      const resource = vscode.Uri.parse(state.resource);
      const locked = state.locked;
      const line = state.line;
      const resourceColumn = state.resourceColumn;

      const preview = DynamicPreview.revive(
        { resource, locked, line, resourceColumn },
        webview,
        this._contentProvider,
        // this._previewConfigurations,
        this._logger,
        this._topmostLineMonitor,
        this._contributions
        // this._opener
      );

      this._registerDynamicPreview(preview);
    } catch (e) {
      console.error(e);

      webview.webview.html = /* html */ `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!-- Disable pinch zooming -->
				<meta name="viewport"
					content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

				<title>Nomifactory JA Lang Preview</title>

				<style>
					html, body {
						min-height: 100%;
						height: 100%;
					}

					.error-container {
						display: flex;
						justify-content: center;
						align-items: center;
						text-align: center;
					}
				</style>

				<meta http-equiv="Content-Security-Policy" content="default-src 'none';">
			</head>
			<body class="error-container">
				<p>${vscode.l10n.t("An unexpected error occurred while restoring the Nomifactory JA Lang preview.")}</p>
			</body>
			</html>`;
    }
  }

  public async resolveCustomTextEditor(document: vscode.TextDocument, webview: vscode.WebviewPanel): Promise<void> {
    const lineNumber = this._topmostLineMonitor.getPreviousStaticTextEditorLineByUri(document.uri);
    const preview = StaticPreview.revive(
      document.uri,
      webview,
      this._contentProvider,
      // this._previewConfigurations,
      this._topmostLineMonitor,
      this._logger,
      this._contributions,
      // this._opener,
      lineNumber
    );
    this._registerStaticPreview(preview);
  }

  private _createNewDynamicPreview(resource: vscode.Uri, previewSettings: DynamicPreviewSettings): DynamicPreview {
    const activeTextEditorURI = vscode.window.activeTextEditor?.document.uri;
    const scrollLine = activeTextEditorURI?.toString() === resource.toString() ? vscode.window.activeTextEditor?.visibleRanges[0].start.line : undefined;
    const preview = DynamicPreview.create(
      {
        resource,
        resourceColumn: previewSettings.resourceColumn,
        locked: previewSettings.locked,
        line: scrollLine,
      },
      previewSettings.previewColumn,
      this._contentProvider,
      // this._previewConfigurations,
      this._logger,
      this._topmostLineMonitor,
      this._contributions
      // this._opener
    );

    this._activePreview = preview;
    return this._registerDynamicPreview(preview);
  }

  private _registerDynamicPreview(preview: DynamicPreview): DynamicPreview {
    this._dynamicPreviews.add(preview);

    preview.onDispose(() => {
      this._dynamicPreviews.delete(preview);
    });

    this._trackActive(preview);

    preview.onDidChangeViewState(() => {
      // Remove other dynamic previews in our column
      disposeAll(Array.from(this._dynamicPreviews).filter((otherPreview) => preview !== otherPreview && preview.matches(otherPreview)));
    });
    return preview;
  }

  private _registerStaticPreview(preview: StaticPreview): StaticPreview {
    this._staticPreviews.add(preview);

    preview.onDispose(() => {
      this._staticPreviews.delete(preview);
    });

    this._trackActive(preview);
    return preview;
  }

  private _trackActive(preview: IManagedPreview): void {
    preview.onDidChangeViewState(({ webviewPanel }) => {
      this._activePreview = webviewPanel.active ? preview : undefined;
    });

    preview.onDispose(() => {
      if (this._activePreview === preview) {
        this._activePreview = undefined;
      }
    });
  }
}
