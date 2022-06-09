import {
  commands,
  Disposable,
  ExtensionContext,
  LanguageClient,
  window,
} from "coc.nvim";
import { existsSync } from "fs";
import {
  ILanguageServerPackages,
  LanguageServerProvider,
  LanguageServerRepository,
} from "./langserver";

type EnsureInstalledResult =
  | { available: true; path: string }
  | ({ available: false } & (
      | { installed: true }
      | { installed: false; error: any }
    ));

type EnsureUpdatedResult =
  | { status: "customPath" | "upToDate" }
  | ({
      status: "outdated";
      startedClientDisposable: Disposable | null;
    } & (
      | {
          updated: false;
          versions: { oldVersion: string; newVersion: string } | null;
          error: any;
        }
      | {
          updated: true;
          versions: { oldVersion: string; newVersion: string };
        }
    ));

export class ServerInstaller {
  private readonly provider: LanguageServerProvider;

  constructor(
    private readonly serverName: string,
    extctx: ExtensionContext,
    packs: ILanguageServerPackages,
    private readonly repo: LanguageServerRepository,
    private readonly customPath: string | null
  ) {
    this.provider = new LanguageServerProvider(extctx, serverName, packs, repo);
  }

  public get isCustomPath(): boolean {
    return !!this.customPath;
  }

  public get path(): string | null {
    const customPath = this.customPath;
    if (customPath) {
      return existsSync(customPath) ? customPath : null;
    }
    return this.provider.getLanguageServerIfDownloaded();
  }

  public checkInstalled(): boolean {
    const path = this.path;
    return !!path && existsSync(path);
  }

  public async checkVersion(): Promise<
    | { result: "customPath" }
    | { result: "different"; currentVersion: string; latestVersion: string }
    | { result: "same" }
  > {
    const customPath = this.customPath;
    if (customPath) {
      return { result: "customPath" };
    }

    const currentVersion = this.provider.loadLocalDownloadInfo()?.version;
    const latestVersion = (await this.provider.fetchDownloadInfo()).version;
    return currentVersion !== latestVersion
      ? {
          result: "different",
          currentVersion,
          latestVersion,
        }
      : { result: "same" };
  }

  public async install(): Promise<void> {
    await this.provider.downloadLanguageServer();
  }

  public async openReleases(): Promise<void> {
    await commands.executeCommand(
      "vscode.open",
      "https://github.com/OmniSharp/omnisharp-roslyn/releases"
    );
  }

  public async ensureInstalled(
    doInstall: boolean,
    ask: boolean
  ): Promise<EnsureInstalledResult> {
    if (this.checkInstalled()) {
      return { available: true, path: this.path! };
    }

    if (this.customPath) {
      // When checkInstalled() failed even if custom path is specified, the
      // server doesn't exist at the specified custom path. And we can't
      // install the server for the user at the custom path.
      return {
        available: false,
        installed: false,
        error:
          `Custom server path (${this.customPath}) is specified,` +
          ` but the server is not found`,
      };
    }

    // Here, server was not found.

    if (!doInstall) {
      return {
        available: false,
        installed: false,
        error: `doInstall is not set`,
      };
    }

    // Should try to install server. Ask before it when needed.
    const yes = "Yes";
    const cancel = "Cancel";
    const choices = ask ? [yes, cancel] : [];
    const source =
      this.repo.kind === "github" ? "GitHub Release" : `${this.repo.url}...`;
    const ans = ask
      ? await window.showErrorMessage(
          `${this.serverName} is not found. Download from ${source}?`,
          ...choices
        )
      : yes;

    if (ans !== yes) {
      return {
        available: false,
        installed: false,
        error: `Cancelled by user`,
      };
    }

    try {
      await this.install();
      return {
        available: true,
        path: this.path!,
        installed: true,
      };
    } catch (err) {
      await window.showErrorMessage(
        `Failed to download ${this.serverName}: ${err}`
      );
      return {
        available: false,
        installed: false,
        error: err,
      };
    }
  }

  public async ensureUpdated(
    ask: boolean,
    doInstall: boolean,
    showMessage: boolean,
    runningClient?: LanguageClient
  ): Promise<EnsureUpdatedResult> {
    let currentVersion: string;
    let latestVersion: string;
    try {
      const result = await this.checkVersion();

      if (result.result === "customPath") {
        return { status: "customPath" };
      }

      if (result.result === "same") {
        if (showMessage) {
          await window.showInformationMessage(
            `Your ${this.serverName} is up to date.`
          );
        }

        return { status: "upToDate" };
      }

      currentVersion = result.currentVersion;
      latestVersion = result.latestVersion;
    } catch (err) {
      await window.showErrorMessage(`Failed to fetch latest version: ${err}`);
      return {
        status: "outdated",
        updated: false,
        versions: null,
        error: err,
        startedClientDisposable: null,
      };
    }

    const versions = {
      oldVersion: currentVersion,
      newVersion: latestVersion,
    };

    if (!doInstall) {
      return {
        status: "outdated",
        updated: false,
        versions,
        error: `doInstall is not set`,
        startedClientDisposable: null,
      };
    }

    const update = "Update";
    const openRelease = "Check_GitHub_Release";
    const cancel = "Cancel";
    const choices =
      this.repo.kind == "github"
        ? [update, openRelease, cancel]
        : [update, cancel];
    const ans = ask
      ? await window.showInformationMessage(
          `${this.serverName} has a new release: ${latestVersion}` +
            ` (current: ${currentVersion})`,
          ...choices
        )
      : update;

    if (ans !== update) {
      return {
        status: "outdated",
        updated: false,
        versions,
        error: `Cancelled by user`,
        startedClientDisposable: null,
      };
    }

    if (runningClient && runningClient.needsStop()) {
      await runningClient.stop();
    }

    try {
      await this.install();
    } catch (err) {
      await window.showErrorMessage(
        `Failed to upgrade ${this.serverName}: ${err}`
      );

      const startedClientDisposable = runningClient
        ? runningClient.start()
        : null;
      return {
        status: "outdated",
        updated: false,
        versions,
        error: err,
        startedClientDisposable,
      };
    }

    const startedClientDisposable = runningClient
      ? runningClient.start()
      : null;

    return {
      status: "outdated",
      updated: true,
      versions,
      startedClientDisposable,
    };
  }
}
