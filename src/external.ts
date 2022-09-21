import { DebugProtocol } from '@vscode/debugprotocol';
import { ConfigurationArguments, GDBServerController, SWOConfigureEvent, calculatePortMask, genDownloadCommands, RTTServerHelper, createPortName, parseHostPort } from './common';
import * as os from 'os';
import * as tmp from 'tmp';
import * as net from 'net';

import { EventEmitter } from 'events';
import * as ChildProcess from 'child_process';
import { GDBDebugSession } from './gdb';

function OpenOCDLog(out : string): void {

}

export class ExternalServerController extends EventEmitter implements GDBServerController {
    public readonly name: string = 'External';
    public readonly portsNeeded: string[] = [];
    private swoPath: string;

    private args: ConfigurationArguments;
    private ports: { [name: string]: number };
    private rttHelper: RTTServerHelper = new RTTServerHelper();

    private session: GDBDebugSession;
    private MI2Leftover: string = '';
    private rttStarted = false;
    private rttAutoStartDetected = false;
    private rttPollTimer: NodeJS.Timeout;

    constructor() {
        super();
        this.swoPath = tmp.tmpNameSync();
    }

    public setPorts(ports: { [name: string]: number }): void {
        this.ports = ports;
    }

    public setArguments(args: ConfigurationArguments): void {
        this.args = args;
        if (this.args.swoConfig.enabled) {
            if (os.platform() === 'win32') {
                this.swoPath = this.swoPath.replace(/\\/g, '/');
            }
        }
    }

    public customRequest(command: string, response: DebugProtocol.Response, args: any): boolean {
        return false;
    }

    public initCommands(): string[] {
        const target = this.args.gdbTarget;
        return [
            `target-select extended-remote ${target}`
        ];
    }

    public launchCommands(): string[] {
        const commands = [
            ...genDownloadCommands(this.args, ['interpreter-exec console "monitor reset halt"']),
            'interpreter-exec console "monitor reset halt"'
        ];

        return commands;
    }

    public attachCommands(): string[] {
        const commands = [
            'interpreter-exec console "monitor halt"'
        ];

        return commands;
    }

    public swoAndRTTCommands(): string[] {
        return [];
    }

    public restartCommands(): string[] {
        const commands: string[] = [
            'interpreter-exec console "monitor reset halt"'
        ];

        return commands;
    }

    public serverExecutable(): string {
        return null;
    }

    public allocateRTTPorts(): Promise<void> {
        return Promise.resolve();
    }
        
    public serverArguments(): string[] {
        return [];
    }

    public initMatch(): RegExp {
        return null;
    }

    public rttCommands(): string[] {
        const commands = [];
        if (this.args.rttConfig.enabled && !this.args.pvtRestartOrReset) {
            const cfg = this.args.rttConfig;
            if ((this.args.request === 'launch') && cfg.clearSearch) {
                // The RTT control block may contain a valid search string from a previous run
                // and RTT ends up outputting garbage. Or, the server could read garbage and
                // misconfigure itself. Following will clear the RTT header which
                // will cause the server to wait for the server to actually be initialized
                commands.push(`interpreter-exec console "monitor mwb ${cfg.address} 0 ${cfg.searchId.length}"`);
            }
            commands.push(`interpreter-exec console "monitor rtt setup ${cfg.address} ${cfg.searchSize} {${cfg.searchId}}"`);
            if (cfg.polling_interval > 0) {
                commands.push(`interpreter-exec console "monitor rtt polling_interval ${cfg.polling_interval}"`);
            }
            
            // tslint:disable-next-line: forin
            for (const channel in this.rttHelper.rttLocalPortMap) {
                const tcpPort = this.rttHelper.rttLocalPortMap[channel];
            }

            // We are starting way too early before the FW has a chance to initialize itself
            // but there is no other handshake mechanism
            commands.push('interpreter-exec console "monitor rtt start"');
            if (this.args.rttConfig.rtt_start_retry === undefined) {
                this.args.rttConfig.rtt_start_retry = 1000;
            }
        }
        return commands;
    }

    private readonly rttSearchStr = 'Control block found at';
    private startRttMonitor() {
        this.session.miDebugger.on('msg', (type, msg) => {
            if (this.rttStarted) { return; }
            msg = this.MI2Leftover + msg;
            const lines = msg.split(/[\r]\n/);
            if (!msg.endsWith('\n')) {
                this.MI2Leftover = lines.pop();
            } else {
                this.MI2Leftover = '';
            }
            for (const line of lines) {
                OpenOCDLog('OpenOCD Output: ' + line);
                if (line.includes(this.rttSearchStr)) {
                    OpenOCDLog('RTT control block found. Done');
                    this.rttStarted = true;
                    if (this.rttPollTimer) {
                        clearTimeout(this.rttPollTimer);
                        this.rttPollTimer = undefined;
                    }
                    break;
                } else if (/rtt:.*will retry/.test(line)) {
                    OpenOCDLog('This version of OpenOCD already know how to poll. Done');
                    this.rttAutoStartDetected = true;
                }
            }
        });

        this.session.miDebugger.on('stopped', async (info: any, reason: string) => {
            if (reason === 'entry') { return; } // Should not happen
            if (!this.rttStarted && this.tclSocket && !this.rttAutoStartDetected) {
                OpenOCDLog('Debugger paused: sending command "rtt start"');
                const result = await this.tclCommand('rtt start');
            }
        });
    }

    public serverLaunchStarted(): void {
        if (this.args.swoConfig.enabled && this.args.swoConfig.source === 'probe' && os.platform() !== 'win32') {
            const mkfifoReturn = ChildProcess.spawnSync('mkfifo', [this.swoPath]);
            this.emit('event', new SWOConfigureEvent({
                type: 'fifo',
                args: this.args,
                path: this.swoPath
            }));
        }
    }

    public serverLaunchCompleted(): void {
        if (this.args.swoConfig.enabled) {
            if (this.args.swoConfig.source === 'probe' && os.platform() === 'win32') {
                this.emit('event', new SWOConfigureEvent({
                    type: 'file',
                    args: this.args,
                    path: this.swoPath
                }));
            }
            else if (this.args.swoConfig.source === 'socket') {
                this.emit('event', new SWOConfigureEvent({
                    type: 'socket',
                    args: this.args,
                    port: this.args.swoConfig.swoPort
                }));
            }
            else if (this.args.swoConfig.source === 'file') {
                this.emit('event', new SWOConfigureEvent({
                    type: 'file',
                    args: this.args,
                    path: this.args.swoConfig.swoPath
                }));
            }
            else if (this.args.swoConfig.source === 'serial') {
                this.emit('event', new SWOConfigureEvent({
                    type: 'serial',
                    args: this.args,
                    device: this.args.swoConfig.swoPath,
                    baudRate: this.args.swoConfig.swoFrequency
                }));
            }
        }
    }

    private tclCommandQueue: TclCommandQueue[] = [];
    private tclCommandId: number = 1;
    private tclCommand(cmd: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.tclStartSocket().then(() => {
                if (!cmd) {
                    resolve('');
                    return;
                }
                const newCmd: TclCommandQueue = {
                    cmd: cmd,
                    id: this.tclCommandId++,
                    resolve: resolve,
                    reject: reject
                };
                if (this.args.showDevDebugOutput) {
                    this.session.handleMsg('log', `openocd <- ${newCmd.id}-${cmd}\n`);
                }
                this.tclCommandQueue.push(newCmd);
                this.tclSendData(cmd);
            }, (e) => {
                reject(e);
                return null;
            });
        });
    }

    private tclSocket: net.Socket = undefined;      // If null, it was opened once but then later closed due to error or the other end closed it
    private tclSocketBuf = '';
    private readonly tclDelimit = String.fromCharCode(0x1a);
    private dbgPollCounter = 0;

    public tclStartSocket(): Promise<void> {
        if (this.tclSocket) {
            return Promise.resolve();
        }
        return new Promise<void>(async (resolve, reject) => {
            if (this.tclSocket === undefined) {
                const tclPortName = createPortName(0, 'tclPort');
                const tclPortNum = this.ports[tclPortName];
                const obj = {
                    host: parseHostPort(this.args.gdbTarget).host,
                    port: tclPortNum
                };
                this.tclSocket = net.createConnection(obj, () => {
                    resolve();
                });
                this.tclSocket.on('data', this.tclRecvTclData.bind(this));
                this.tclSocket.on('end', () => {
                    this.tclSocket = null;
                });
                this.tclSocket.on('close', () => {
                    this.tclSocket = null;
                });
                this.tclSocket.on('error', (e) => {
                    if (this.tclSocket) {
                        this.tclSocket = null;
                        reject(e);
                    }
                });
            } else {
                reject(new Error('OpenOCD tcl socket already closed'));
            }
        });
    }

    private tclRecvTclData(buffer: Buffer) {
        const str = this.tclSocketBuf + buffer.toString('utf8');
        const packets = str.split(this.tclDelimit);
        if (!str.endsWith(this.tclDelimit)) {
            this.tclSocketBuf = packets.pop();
        } else {
            packets.pop();      // Remove trailing empty string
            this.tclSocketBuf = '';
        }
        if ((this.tclCommandQueue.length > 0) && (packets.length > 0)) {
            const next = this.tclCommandQueue.shift();
            next.result = packets.shift();
            if (this.args.showDevDebugOutput) {
                this.session.handleMsg('log', `openocd -> ${next.id}-'${next.result}'\n`);
            }
            next.resolve(next.result);
        }
        while (packets.length > 0) {
            const p = packets.shift().trim();
            if (this.args.showDevDebugOutput) {
                this.session.handleMsg('log', `openocd -> '${p}'\n`);
            }
        }
    }

    private tclSendData(data: string) {
        if (data) {
            this.tclSocket.write(data + this.tclDelimit, 'utf8');
        }
    }

    public debuggerLaunchStarted(obj: GDBDebugSession): void {
        this.session = obj;
    }
    public debuggerLaunchCompleted(): void {
        const hasRtt = this.rttHelper.emitConfigures(this.args.rttConfig, this);
        if (hasRtt) {
            this.startRttMonitor();
        }
    }
}

interface TclCommandQueue {
    cmd: string;
    id: number;
    resolve: any;
    reject: any;
    result?: string;
    error?: any;
}
