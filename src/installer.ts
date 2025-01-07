import assert from "assert";
import { commands, ExtensionContext, LanguageClient, window } from "coc.nvim";
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
    private readonly customPath: string | undefined,
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
      "https://github.com/OmniSharp/omnisharp-roslyn/releases",
    );
  }

  public async ensureInstalled(
    ask: boolean,
    doInstall: boolean,
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
    const source =
      this.repo.kind === "github" ? "GitHub Release" : `${this.repo.url}`;
    const message = `${this.serverName} is not found. Download from ${source}?`;
    if (!ask || !(await window.showPrompt(message))) {
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
        `Failed to download ${this.serverName}: ${err}`,
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
    runningClient: LanguageClient | undefined,
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
        runningClient?.start();
        if (result.available) {
          // Previously not installed but ensureInstalled() make it available,
          // so it should successfully install the server.
          assert(result.installed);

          return {
            status: "outdated",
            updated: true,
            versions: {
              oldVersion: undefined,
              newVersion: result.version,
            },
          };
        } else {
          return {
            status: "outdated",
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
            `Your ${this.serverName} is up to date.`,
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
      };
    }

    const message = `${this.serverName} has a new release: ${latestVersion} (current: ${currentVersion})`;
    if (!ask || !(await window.showPrompt(message))) {
      return {
        status: "outdated",
        updated: false,
        versions,
        error: `Cancelled by user`,
      };
    }

    if (runningClient && runningClient.needsStop()) {
      await runningClient.stop();
    }

    try {
      await this.install();
    } catch (err) {
      await window.showErrorMessage(
        `Failed to upgrade ${this.serverName}: ${err}`,
      );

      runningClient?.start();
      return {
        status: "outdated",
        updated: false,
        versions,
        error: err,
      };
    }

    runningClient?.start();
    return {
      status: "outdated",
      updated: true,
      versions,
    };
  }
}
