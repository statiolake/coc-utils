import assert from "assert";
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
  | ({ available: true; path: string } & (
      | { installed: false }
      | { installed: true; version: string }
    ))
  | { available: false; error: any };

type EnsureUpdatedResult =
  | { status: "customPath" | "upToDate" }
  | ({
      status: "outdated";
      startedClientDisposable: Disposable | undefined;
    } & (
      | {
          updated: false;
          versions:
            | { oldVersion: string | undefined; newVersion: string }
            | undefined;
          error: any;
        }
      | {
          updated: true;
          versions: { oldVersion: string | undefined; newVersion: string };
        }
    ));

export class ServerInstaller {
  private readonly provider: LanguageServerProvider;

  constructor(
    private readonly serverName: string,
    extctx: ExtensionContext,
    packs: ILanguageServerPackages,
    private readonly repo: LanguageServerRepository,
    private readonly customPath: string | undefined
  ) {
    this.provider = new LanguageServerProvider(extctx, serverName, packs, repo);
  }

  public get isCustomPath(): boolean {
    return !!this.customPath;
  }

  public get path(): string | undefined {
    const customPath = this.customPath;
    if (customPath) {
      return existsSync(customPath) ? customPath : undefined;
    }
    return this.provider.getLanguageServerIfDownloaded();
  }

  public checkInstalled(): boolean {
    const path = this.path;
    return !!path && existsSync(path);
  }

  public async checkVersion(): Promise<
    | { result: "notInstalled" }
    | { result: "customPath" }
    | { result: "different"; currentVersion: string; latestVersion: string }
    | { result: "same" }
  > {
    const customPath = this.customPath;
    if (customPath) {
      return { result: "customPath" };
    }

    const currentVersion = this.provider.loadLocalDownloadInfo()?.version;
    if (currentVersion === undefined) {
      return { result: "notInstalled" };
    }

    const latestVersion = (await this.provider.fetchDownloadInfo()).version;

    return currentVersion !== latestVersion
      ? {
          result: "different",
          currentVersion,
          latestVersion,
        }
      : { result: "same" };
  }

  public async install(force: boolean = false): Promise<void> {
    if (force) {
      this.provider.cleanupLanguageServer();
    }
    await this.provider.downloadLanguageServer();
  }

  public async openReleases(): Promise<void> {
    await commands.executeCommand(
      "vscode.open",
      "https://github.com/OmniSharp/omnisharp-roslyn/releases"
    );
  }

  public async ensureInstalled(
    ask: boolean,
    doInstall: boolean
  ): Promise<EnsureInstalledResult> {
    if (this.checkInstalled()) {
      return { available: true, path: this.path!, installed: false };
    }

    if (this.customPath) {
      // When checkInstalled() failed even if custom path is specified, the
      // server doesn't exist at the specified custom path. And we can't
      // install the server for the user at the custom path.
      return {
        available: false,
        error:
          `Custom server path (${this.customPath}) is specified,` +
          ` but the server is not found`,
      };
    }

    // Here, server was not found.

    if (!doInstall) {
      return {
        available: false,
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
        error: `Cancelled by user`,
      };
    }

    try {
      await this.install();
      const version = this.provider.getLanguageServerVersion()!;
      return {
        available: true,
        path: this.path!,
        installed: true,
        version: version,
      };
    } catch (err) {
      await window.showErrorMessage(
        `Failed to download ${this.serverName}: ${err}`
      );
      return {
        available: false,
        error: err,
      };
    }
  }

  public async ensureUpdated(
    ask: boolean,
    doInstall: boolean,
    showMessage: boolean,
    runningClient: LanguageClient | undefined
  ): Promise<EnsureUpdatedResult> {
    let currentVersion: string;
    let latestVersion: string;
    try {
      const result = await this.checkVersion();

      if (result.result === "notInstalled") {
        if (runningClient?.needsStop()) {
          runningClient?.stop();
        }

        const result = await this.ensureInstalled(ask, doInstall);
        if (result.available) {
          // Previously not installed but ensureInstalled() make it available,
          // so it should successfully install the server.
          assert(result.installed);

          return {
            status: "outdated",
            startedClientDisposable: runningClient?.start(),
            updated: true,
            versions: {
              oldVersion: undefined,
              newVersion: result.version,
            },
          };
        } else {
          return {
            status: "outdated",
            startedClientDisposable: runningClient?.start(),
            updated: false,
            versions: undefined,
            error: result.error,
          };
        }
      }

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
        versions: undefined,
        error: err,
        startedClientDisposable: undefined,
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
        startedClientDisposable: undefined,
      };
    }

    const update = "Update";
    const openRelease = "Check GitHub Release";
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
        startedClientDisposable: undefined,
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

      const startedClientDisposable = runningClient?.start();
      return {
        status: "outdated",
        updated: false,
        versions,
        error: err,
        startedClientDisposable,
      };
    }

    const startedClientDisposable = runningClient?.start();
    return {
      status: "outdated",
      updated: true,
      versions,
      startedClientDisposable,
    };
  }
}
