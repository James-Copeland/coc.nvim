import { SpawnOptions } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { Disposable, Emitter, Event } from 'vscode-languageserver-protocol'
import which from 'which'
import { ForkOptions, LanguageClient, LanguageClientOptions, ServerOptions, State, Transport, TransportKind } from '../language-client/main'
import { IServiceProvider, LanguageServerConfig, ServiceStat } from '../types'
import { disposeAll, echoErr, echoMessage } from '../util'
import workspace from '../workspace'
const logger = require('../util/logger')('language-client-index')

function isInteger(o: any): boolean {
  if (typeof o === 'number') return true
  if (typeof o === 'string') {
    return /^\d+$/.test(o)
  }
  return false
}

export class LanguageService implements IServiceProvider {
  public enable: boolean
  public languageIds: string[]
  public readonly state: ServiceStat
  private configSections: string | string[]
  private _onDidServiceReady = new Emitter<void>()
  protected client: LanguageClient
  protected readonly disposables: Disposable[] = []
  public readonly onServiceReady: Event<void> = this._onDidServiceReady.event

  constructor(
    public readonly id: string,
    public readonly name: string,
    protected config: LanguageServerConfig,
    configSections?: string | string[]
  ) {
    this.state = ServiceStat.Initial
    this.enable = config.enable !== false // tslint:disable-line
    this.languageIds = config.filetypes
    this.configSections = configSections || config.configSection || `${this.id}.settings`
    if (!config.command && !config.module) {
      echoErr(workspace.nvim, `Command and module not found for ${id}`)
      logger.error(`invalid command of ${id}`)
      this.enable = false
    }
  }

  public async init(): Promise<void> {
    let { config, name } = this
    let { args, module, command, port, host } = config
    args = args || []
    if (command) {
      try {
        let resolved = which.sync(config.command)
        if (args.indexOf('--node-ipc') !== -1) {
          module = resolved
        }
      } catch (e) {
        echoMessage(workspace.nvim, `Executable ${command} not found`)
        this.enable = false
        return
      }
    }
    let isModule = module != null
    if (typeof module == 'function') {
      module = await module()
    }
    if (!module && !command) return
    let serverOptions: ServerOptions
    if (isModule) {
      serverOptions = {
        module,
        transport: this.getTransportKind(),
        args: config.args,
        options: this.getOptions(true)
      }
    } else if (command) {
      serverOptions = {
        command,
        args: config.args || [],
        options: this.getOptions()
      }
    } else if (port) {
      serverOptions = () => {
        return new Promise((resolve, reject) => {
          let client = new net.Socket()
          client.connect(port, host || '127.0.0.1', () => {
            resolve({
              reader: client,
              writer: client
            })
          })
          client.on('error', e => {
            reject(new Error(`Connection error for ${this.id}: ${e.message}`))
          })
        })
      }
    }
    let documentSelector = this.languageIds
    let clientOptions: LanguageClientOptions = {
      forceFullSync: config.forceFullSync,
      documentSelector,
      synchronize: {
        configurationSection: this.configSections
      },
      initializationOptions: config.initializationOptions || {}
    }
    clientOptions = this.resolveClientOptions(clientOptions)
    // Create the language client and start the client.
    let client = this.client = new LanguageClient(
      this.id,
      name,
      serverOptions,
      clientOptions)

    client.onDidChangeState(changeEvent => {
      let { oldState, newState } = changeEvent
      let oldStr = this.stateString(oldState)
      let newStr = this.stateString(newState)
      logger.info(`${name} state change: ${oldStr} => ${newStr}`)
    }, null, this.disposables)
    Object.defineProperty(this, 'state', {
      get: () => {
        return client.serviceState
      }
    })
    client.registerProposedFeatures()
    let disposable = client.start()
    this.disposables.push(disposable)
    await new Promise(resolve => { // tslint:disable-line
      client.onReady().then(() => {
        this._onDidServiceReady.fire(void 0)
        resolve()
      }, e => {
        logger.error(e.message)
        resolve()
      })
    })
    return
  }

  private getTransportKind(): Transport {
    let { config } = this
    let { args } = config
    if (!args || args.indexOf('--node-ipc') !== -1) {
      return TransportKind.ipc
    }
    if (args.indexOf('--stdio') !== -1) {
      return TransportKind.stdio
    }
    let idx = args.findIndex(s => s === '--socket' || s === '--port')
    if (idx !== -1 && isInteger(args[idx + 1])) {
      let n = args[idx + 1]
      return {
        kind: TransportKind.socket,
        port: Number(n)
      }
    }
    return TransportKind.ipc
  }

  protected resolveClientOptions(clientOptions: LanguageClientOptions): LanguageClientOptions {
    return clientOptions
  }

  private getOptions(isModule = false): SpawnOptions | ForkOptions {
    let { config } = this
    let { cwd, shell, detached, execArgv } = config
    cwd = cwd ? path.isAbsolute(cwd) ? cwd
      : path.resolve(workspace.root, cwd)
      : workspace.root
    try {
      fs.statSync(cwd)
    } catch (e) {
      cwd = workspace.root
    }
    if (isModule) return { cwd, execArgv: execArgv || [] }
    return {
      cwd,
      detached: !!detached,
      shell: !!shell
    }
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }

  public async restart(): Promise<void> {
    if (!this.client) return
    if (this.state == ServiceStat.Running) {
      await this.stop()
    }
    this.client.restart()
  }

  private stateString(state: State): string {
    switch (state) {
      case State.Running:
        return 'running'
      case State.Starting:
        return 'starting'
      case State.Stopped:
        return 'stopped'
    }
    return 'unknown'
  }

  public async stop(): Promise<void> {
    if (!this.client) return
    await Promise.resolve(this.client.stop())
  }
}
