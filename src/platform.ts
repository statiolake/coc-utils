import process = require("process");

export enum OperatingSystem {
    Unknown,
    Windows,
    MacOS,
    Linux,
}

export interface IPlatformDetails {
    operatingSystem: OperatingSystem;
    isOS64Bit: boolean;
    isProcess64Bit: boolean;
    architecture: string;
}

export function getPlatformDetails(): IPlatformDetails {
    let operatingSystem = OperatingSystem.Unknown;

    if (process.platform === "win32") {
        operatingSystem = OperatingSystem.Windows;
    } else if (process.platform === "darwin") {
        operatingSystem = OperatingSystem.MacOS;
    } else if (process.platform === "linux") {
        operatingSystem = OperatingSystem.Linux;
    }

    const isProcess64Bit = 
      process.arch === "x64"
      || process.arch === "aarch64"
      || process.arch === "arm64";

    return {
        operatingSystem,
        isOS64Bit: isProcess64Bit || process.env.hasOwnProperty("PROCESSOR_ARCHITEW6432"),
        isProcess64Bit,
        architecture: process.arch
    };
}

export function getPlatformSignature(): string {
    const plat = getPlatformDetails()

    const os_sig = (() => {
        switch (plat.operatingSystem) {
            case OperatingSystem.Windows: return "win"
            case OperatingSystem.Linux: return "linux"
            case OperatingSystem.MacOS: return "osx"
            default: return "unknown"
        }
    })()

    return `${os_sig}-${plat.architecture}`
}

