import { ExtensionContext, window } from "coc.nvim";
import unzip from "extract-zip";
import * as fs from "fs";
import { createReadStream, createWriteStream } from "fs";
import * as path from "path";
import * as rimraf from "rimraf";
import * as tar from "tar";
import { createGunzip } from "zlib";
import {
  getPlatformDetails,
  getPlatformSignature,
  OperatingSystem,
} from "./platform";
import { checkIfFileExists, httpsGet, httpsGetJson } from "./utils";

type Archiver = "zip" | "gzip" | "tar-gzip";

export interface ILanguageServerPackage {
  //  the executable of the language server,
  //  in the downloaded and extracted package
  executable: string;
  platformFilename: string | RegExp;
  archiver?: Archiver;
}

export interface ILanguageServerPackages {
  [platform: string]: ILanguageServerPackage;
}

export type LanguageServerRepository =
  | { kind: "github"; repo: string; channel: string }
  | { kind: "url-prefix"; url: string };

interface IGithubAsset {
  name: string;
  browser_download_url: string;
}

interface IDownloadInfo {
  url: string;
  version: string;
  id: number;
  downloadedTime: number;
}

interface IGithubRelease {
  // the assets collection
  assets: IGithubAsset[];
  // the name of the release
  name: string;
  // the unique id of the release
  id: number;
  tag_name?: string;
  prerelease?: boolean;
  draft?: boolean;
}

export class LanguageServerProvider {
  private extensionStoragePath: string;
  private languageServerName: string;
  private languageServerDirectory: string;
  private languageServerArchive: string;
  private languageServerArchiver: Archiver;
  private languageServerExe: string;
  private languageServerPackage: ILanguageServerPackage;

  constructor(
    extension: ExtensionContext,
    name: string,
    packs: ILanguageServerPackages,
    private repo: LanguageServerRepository,
  ) {
    const platsig = getPlatformSignature();
    this.languageServerName = name;
    this.extensionStoragePath = extension.storagePath;
    this.languageServerPackage = packs[platsig];

    if (!this.languageServerPackage) {
      throw "Platform not supported";
    }

    this.languageServerDirectory = path.join(
      this.extensionStoragePath,
      "server",
    );
    this.languageServerArchiver = this.languageServerPackage.archiver ?? "zip";
    this.languageServerArchive =
      this.languageServerDirectory + "." + this.languageServerArchiver;
    this.languageServerExe = path.join(
      this.languageServerDirectory,
      this.languageServerPackage.executable,
    );
  }

  get localDownloadInfoPath(): string {
    return path.join(this.extensionStoragePath, "downloadinfo.json");
  }

  saveLocalDownloadInfo(inf: IDownloadInfo) {
    let content = JSON.stringify(inf);
    let fname = this.localDownloadInfoPath;
    fs.writeFileSync(fname, content, "utf-8");
  }

  public loadLocalDownloadInfo(): IDownloadInfo | undefined {
    let fname = this.localDownloadInfoPath;
    if (!checkIfFileExists(fname)) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(fname, "utf-8"));
  }

  public async fetchDownloadInfo(): Promise<IDownloadInfo> {
    const platformFilename = this.languageServerPackage.platformFilename;
    if (this.repo.kind === "github") {
      let { repo: repo, channel: channel } = this.repo;
      let api_url = `https://api.github.com/repos/${repo}/releases/${channel}`;
      let api_result = await httpsGetJson<IGithubRelease>(api_url);
      let matched_assets = api_result.assets.filter((x) => {
        if (typeof platformFilename === "string") {
          return x.name === platformFilename;
        } else {
          return platformFilename.exec(x.name);
        }
      });
      return {
        url: matched_assets[0].browser_download_url,
        version: api_result.name,
        id: api_result.id,
        downloadedTime: Date.now(),
      };
    } else if (this.repo.kind === "url-prefix") {
      return {
        url: `${this.repo.url}/${platformFilename}`,
        version: "",
        id: 0,
        downloadedTime: Date.now(),
      };
    }
    throw new Error("unsupported repo kind.");
  }

  public async downloadLanguageServer(): Promise<void> {
    await window.withProgress(
      { title: `Installing ${this.languageServerName}` },
      async (progress, token) => {
        if (!fs.existsSync(this.extensionStoragePath)) {
          fs.mkdirSync(this.extensionStoragePath, { recursive: true });
        }

        progress.report({
          message: `Looking for ${this.languageServerName} updates`,
        });

        let downinfo = await this.fetchDownloadInfo();
        let localinfo = this.loadLocalDownloadInfo();
        if (
          localinfo &&
          localinfo.id === downinfo.id &&
          localinfo.version === downinfo.version
        ) {
          // update localinfo timestamp and return
          localinfo.downloadedTime = Date.now();
          this.saveLocalDownloadInfo(localinfo);
          return;
        }

        await this.cleanupLanguageServer();
        fs.mkdirSync(this.languageServerDirectory, { recursive: true });

        progress.report({ message: `Downloading ${this.languageServerName}` });

        await httpsGet(downinfo.url, (resolve, _, res) => {
          let file = fs.createWriteStream(this.languageServerArchive);
          let stream = res.pipe(file);
          stream.on("finish", resolve);
        });

        progress.report({ message: `Extracting ${this.languageServerName}` });

        switch (this.languageServerArchiver) {
          case "zip":
            await unzip(this.languageServerArchive, {
              dir: this.languageServerDirectory,
            });
            break;

          case "gzip":
            await new Promise<void>((resolve, reject) => {
              const read = createReadStream(this.languageServerArchive).on(
                "error",
                (err) => {
                  gunzip.end();
                  reject(err);
                },
              );
              const gunzip = createGunzip().on("error", (err) => {
                out.end();
                reject(err);
              });
              const out = createWriteStream(this.languageServerExe).on(
                "error",
                reject,
              );
              read.pipe(gunzip).pipe(out).on("finish", resolve);
            });
            break;

          case "tar-gzip":
            await new Promise<void>((resolve, reject) => {
              const read = createReadStream(this.languageServerArchive).on(
                "error",
                (err) => {
                  gunzip.end();
                  reject(err);
                },
              );
              const gunzip = createGunzip().on("error", (err) => {
                reject(err);
              });
              const extractor = tar.extract({
                cwd: this.languageServerDirectory,
              });
              read.pipe(gunzip).pipe(extractor).on("finish", resolve);
            });
            break;
        }

        fs.unlinkSync(this.languageServerArchive);
        // update timestamp
        downinfo.downloadedTime = Date.now();
        this.saveLocalDownloadInfo(downinfo);
      },
    );
  }

  public async cleanupLanguageServer(timeout: number = 1000): Promise<boolean> {
    // On Windows, the executable file remains locked by the OS immediately
    // after the server process is killed, so we need to try multiple times.
    const startTime = Date.now();
    let lastError = undefined;

    while (Date.now() - startTime < timeout) {
      if (!fs.existsSync(this.languageServerDirectory)) return false;
      try {
        rimraf.sync(this.languageServerDirectory);
        rimraf.sync(this.localDownloadInfoPath);
        return true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    throw lastError;
  }

  // returns the full path to the language server executable
  public async getLanguageServer(): Promise<string> {
    const plat = getPlatformDetails();

    if (!fs.existsSync(this.languageServerExe) || this.shouldRegularUpdate()) {
      await this.downloadLanguageServer();
    }

    // Make sure the server is executable
    if (plat.operatingSystem !== OperatingSystem.Windows) {
      fs.chmodSync(this.languageServerExe, "755");
    }

    return this.languageServerExe;
  }

  // returns the full path to the language server executable if it is
  // already downloaded, otherwise returns undefined.
  public getLanguageServerIfDownloaded(): string | undefined {
    if (!fs.existsSync(this.languageServerExe)) return undefined;
    return this.languageServerExe;
  }

  public getLanguageServerVersion(): string | undefined {
    return this.loadLocalDownloadInfo()?.version;
  }

  shouldRegularUpdate(): boolean {
    let thres = 7 * 86400000;
    let info = this.loadLocalDownloadInfo();
    if (!info) return true;
    let diff = new Date(Date.now() - info.downloadedTime);
    return diff.getTime() >= thres;
  }
}
