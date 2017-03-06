/* @flow */

import send from 'send'
import unique from 'lodash.uniq'
import express from 'express'
import arrayDiff from 'lodash.difference'
import ConfigFile from 'sb-config-file'
import { CompositeDisposable } from 'sb-event-kit'
import { getRelativeFilePath, createWatcher, MessageIssue } from 'pundle-api'
import type Pundle from 'pundle/src'
import type { File, FileChunk, GeneratorResult } from 'pundle-api/types'

import * as Helpers from './helpers'
import type { ServerConfig, ServerState, ServerConfigInput } from '../types'

const WssServer = Helpers.getWssServer()
const cliReporter: Object = require('pundle-reporter-cli')

class Server {
  state: ServerState;
  cache: ConfigFile;
  config: ServerConfig;
  pundle: Pundle;
  connections: Set<Object>;
  subscriptions: CompositeDisposable;
  constructor(pundle: Pundle, config: ServerConfigInput) {
    if (Helpers.isPundleRegistered(pundle)) {
      throw new Error('Cannot create two middlewares on one Pundle instance')
    }

    // TODO:
    // store latest chunks in state
    // and compile the specific chunk when get request is recieved
    // use the chunk labels and a regexp in express path to generate at will
    // only hmr when connected clients

    this.state = {
      queue: Promise.resolve(),
      files: new Map(),
      chunks: [],
      changed: new Map(),
      generated: new Map(),
    }
    this.pundle = pundle
    this.config = Helpers.fillConfig(config)
    this.connections = new Set()
    this.subscriptions = new CompositeDisposable()

    Helpers.registerPundle(pundle, this.config)
  }
  async activate() {
    const app = express()
    const oldFiles: Map<string, File> = new Map()
    const rootDirectory = this.pundle.config.rootDirectory

    this.cache = await ConfigFile.get(await Helpers.getCacheFilePath(rootDirectory), {
      directory: rootDirectory,
      files: [],
    }, {
      prettyPrint: false,
      createIfNonExistent: true,
    })
    if (this.config.useCache) {
      this.pundle.context.unserialize(await this.cache.get('state'))
      const oldFilesArray = await this.cache.get('files')
      oldFilesArray.forEach(function(file) {
        oldFiles.set(file.filePath, file)
      })
    }
    if (oldFiles.size) {
      this.report(`Restoring ${oldFiles.size} files from cache`)
    }

    await this.attachRoutes(app)
    await this.attachComponents()

    const server = app.listen(this.config.port)
    if (this.config.hmrPath) {
      const wss = new WssServer({ server, path: this.config.hmrPath })
      wss.on('connection', (connection) => {
        connection.on('close', () => this.connections.delete(connection))
        this.connections.add(connection)
      })
    }
    this.subscriptions.add(function() {
      server.close()
    })
    this.subscriptions.add(await this.pundle.watch(this.config.useCache, oldFiles))
  }
  attachRoutes(app: Object): void {
    app.get([this.config.bundlePath, `${this.config.bundlePath}*`], (req, res, next) => {
      this.generateChunk(req.url).then(function(chunk) {
        if (!chunk) {
          next()
          return
        }
        if (req.url.endsWith('.js.map')) {
          res.set('content-type', 'application/json')
          res.end(JSON.stringify(chunk.sourceMap))
        } else {
          res.set('content-type', 'application/javascript')
          res.end(chunk.contents)
        }
      }).catch(next)
    })
    app.get('/', function(req, res) {
      res.end('Show a custom filled in index.html here')
    })

    app.use('/', express.static(this.config.rootDirectory))
    if (this.config.redirectNotFoundToIndex) {
      app.use((req, res, next) => {
        if (req.url !== '/' && req.baseUrl !== '/') {
          req.baseUrl = req.url = '/'
          // TODO: Replace this with a route caller, because we are gonna be transforming index.html
          send(req, req.baseUrl, { root: this.config.rootDirectory, index: 'index.html' }).on('error', next).on('directory', next).pipe(res)
        } else next()
      })
    }
  }
  async attachComponents(): Promise<void> {
    let booted = false
    this.subscriptions.add(await this.pundle.loadComponents([
      [cliReporter, {
        log: (text, error) => {
          if (this.config.hmrReports && error.severity && error.severity !== 'info') {
            this.writeToConnections({ type: 'report', text, severity: error.severity || 'error' })
          }
        },
      }],
      createWatcher({
        tick: (_: Object, file: File) => {
          if (booted && file.filePath !== Helpers.browserFile) {
            this.state.changed.set(file.filePath, file)
          }
        },
        ready: () => {
          booted = true
          this.report('Server initialized successfully')
        },
        compile: async (_: Object, chunks: Array<FileChunk>, files: Map<string, File>) => {
          this.state.files = files
          this.state.chunks = chunks
          if (this.connections.size && this.state.changed.size) {
            // TODO: Uncomment this
            // await this.generateForHMR()
          }
        },
      }),
    ]))
  }
  // NOTE: Stuff below this line is called at will and not excuted on activate or whatever
  async generate(chunk: FileChunk) {
    this.state.changed.clear()
    const generated = await this.pundle.generate([chunk], {
      wrapper: 'hmr',
      sourceMap: this.config.sourceMap,
      sourceMapPath: this.config.sourceMapPath,
      sourceNamespace: 'app',
    })
    this.state.generated.set(chunk, generated[0])
  }
  async generateForHMR() {
    const rootDirectory = this.pundle.config.rootDirectory
    const changedFilePaths = unique(Array.from(this.filesChanged))

    const relativeChangedFilePaths = changedFilePaths.map(i => getRelativeFilePath(i, rootDirectory))
    this.report(`Sending HMR to ${this.connections.size} clients of [ ${
      relativeChangedFilePaths.length > 4 ? `${relativeChangedFilePaths.length} files` : relativeChangedFilePaths.join(', ')
    } ]`)
    this.writeToConnections({ type: 'report-clear' })
    const generated = await this.pundle.generate(this.state.files.filter(entry => ~changedFilePaths.indexOf(entry.filePath)), {
      entry: [],
      wrapper: 'none',
      sourceMap: this.config.sourceMap,
      sourceMapPath: 'inline',
      sourceNamespace: 'app',
      sourceMapNamespace: `hmr-${Date.now()}`,
    })
    // TODO: Uncomment this
    // const newFiles = arrayDiff(generated.filePaths, this.state.generated.filePaths)
    // this.writeToConnections({ type: 'hmr', contents: generated.contents, files: generated.filePaths, newFiles })
    this.writeToConnections({ type: 'hmr', contents: generated.contents, files: generated.filePaths })
    this.filesChanged.clear()
  }
  async generateChunk(url: string): Promise<?GeneratorResult> {
    const chunkId = Helpers.getChunkId(url, this.config.bundlePath)
    const chunk = this.state.chunks.find(entry => entry.id.toString() === chunkId || entry.label === chunkId)
    if (!chunk) {
      return null
    }

    let chunkIsModified = !this.state.generated.has(chunk)
    for (const filePath of this.state.changed.keys()) {
      const fileMatches = chunk.files.has(filePath)
      if (fileMatches) {
        chunkIsModified = true
        break
      }
    }

    if (chunkIsModified) {
      this.enqueue(() => this.generate(chunk))
      await this.state.queue
    }
    return this.state.generated.get(chunk)
  }
  report(contents: string, severity: 'info' | 'error' | 'warning' = 'info') {
    this.pundle.context.report(new MessageIssue(contents, severity))
  }
  enqueue(callback: Function): void {
    this.state.queue = this.state.queue.then(() => callback()).catch(e => this.pundle.context.report(e))
  }
  writeToConnections(contents: Object): void {
    const stringifiedContents = JSON.stringify(contents)
    this.connections.forEach(connection => connection.send(stringifiedContents))
  }
  dispose() {
    if (!this.subscriptions.disposed) {
      Helpers.unregisterPundle(this.pundle)
      this.cache.setSync('files', Array.from(this.state.files.values()))
      this.cache.setSync('state', this.pundle.context.serialize())
    }
    this.subscriptions.dispose()
  }
}

module.exports = Server
