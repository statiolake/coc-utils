import { LanguageClient, StatusBarItem, workspace } from 'coc.nvim';

export interface StartProgress {
    title: string 
    nFiles: number
}

export function createProgressListeners(client: LanguageClient) {
    // Create a "checking files" progress indicator
    let progressListener = new class {
        countChecked = 0
        nFiles = 0
        title: string = ""
        statusBarItem: StatusBarItem = null;

        startProgress(start: StartProgress) {
            // TODO implement user cancellation (???)
            this.title =  start.title
            this.nFiles = start.nFiles
            this.statusBarItem = workspace.createStatusBarItem(0, { progress : true });
            this.statusBarItem.text = this.title;
        }

        private percentComplete() {
            return Math.floor(this.countChecked / (this.nFiles + 1) * 100);
        }

        incrementProgress(fileName: string) {
            if (this.statusBarItem != null) {
                this.countChecked++;
                let newPercent = this.percentComplete();
                this.statusBarItem.text = `${this.title} (${newPercent}%)... [${fileName}]`
                this.statusBarItem.show();
            }
        }

        endProgress() {
            this.countChecked = 0
            this.nFiles = 0
            this.statusBarItem.hide()
            this.statusBarItem.dispose()
            this.statusBarItem = null
        }
    }

    // Use custom notifications to drive progressListener
    client.onNotification(`${client.id}/startProgress`, (start: StartProgress) => {
        progressListener.startProgress(start);
    });
    client.onNotification(`${client.id}/incrementProgress`, (fileName: string) => {
        progressListener.incrementProgress(fileName);
    });
    client.onNotification(`${client.id}/endProgress`, () => {
        progressListener.endProgress();
    });
}

