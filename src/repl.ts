import coc = require("coc.nvim");
import {workspace} from 'coc.nvim'
import {sleep, getCurrentSelection} from './utils';

export class REPLProcess {

    public onExited: coc.Event<void>;
    private onExitedEmitter = new coc.Emitter<void>();
    private consoleTerminal: coc.Terminal = undefined;
    private consoleCloseSubscription: coc.Disposable;
    private log: coc.OutputChannel;

    constructor(private title: string, private progPath: string, private progArgs: string[]) {
        this.log = coc.workspace.createOutputChannel(title)
        this.onExited = this.onExitedEmitter.event;
    }

    public async start() {

        if (this.consoleTerminal) {
            this.log.appendLine(`${this.title} already started.`)
            this.consoleTerminal.show(true)
            return
        }

        this.log.appendLine(`${this.title} starting.`)

        this.consoleTerminal = await coc.workspace.createTerminal({
            name: this.title,
            shellPath: this.progPath,
            shellArgs: this.progArgs
        })

        this.consoleCloseSubscription =
            coc.workspace.onDidCloseTerminal(
                (terminal) => {
                    if (terminal === this.consoleTerminal) {
                        this.log.appendLine(`${this.title} terminated or terminal UI was closed`);
                        this.onExitedEmitter.fire();
                    }
                }, this);
    }

    public showConsole(preserveFocus: boolean) {
        if (this.consoleTerminal) {
            this.consoleTerminal.show(preserveFocus);
        }
    }

    public async eval(line: string) {
        if (this.consoleTerminal) {
            this.consoleTerminal.sendText(line)
        }
    }

    public async scrollToBottom() {
        this.consoleTerminal.show(false)
        await sleep(200)
        await coc.workspace.nvim.command("wincmd w")
    }

    public dispose() {

        if (this.consoleCloseSubscription) {
            this.consoleCloseSubscription.dispose();
            this.consoleCloseSubscription = undefined;
        }

        if (this.consoleTerminal) {
            this.log.appendLine(`Terminating ${this.title} process...`);
            this.consoleTerminal.dispose();
            this.consoleTerminal = undefined;
        }
    }
}

export interface IREPLDescriptor 
{
    filetype: string
    title: string
    command: string
    args: string[]
    // some REPLs require a special sequence to be sent
    // to commit evaluation.
    commit: string
}

export class REPLProvider {
    private m_proc: REPLProcess = undefined

    constructor(public desc: IREPLDescriptor) {
    }

    async createREPL() {
        if (this.m_proc) {
            this.m_proc.dispose()
            this.m_proc = undefined
        }
        this.m_proc = new REPLProcess(this.desc.title, this.desc.command, this.desc.args)
        this.m_proc.onExited(() => {
            this.m_proc = undefined
        })
        await this.m_proc.start()
        return this.m_proc.onExited
    }

    public async eval(mode: string) {

        let document = await workspace.document
        if (!document || document.filetype !== this.desc.filetype) {
            return
        }

        if (!this.m_proc) {
            await this.createREPL()
        }

        const win = await workspace.nvim.window

        // TODO: move to workspace.getCurrentSelection when we get an answer:
        // https://github.com/neoclide/coc.nvim/issues/933
        const content = await getCurrentSelection(mode)
        for (let line of content) {
            await this.m_proc.eval(line)
        }
        await this.m_proc.eval(this.desc.commit)
        // see :help feedkeys
        await workspace.nvim.call('eval', `feedkeys("\\<esc>${content.length}j", "in")`)
        // await currentREPL.scrollToBottom()

        await workspace.nvim.setWindow(win)
    }
}

