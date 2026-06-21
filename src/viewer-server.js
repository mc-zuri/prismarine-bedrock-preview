const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')
const mcRegistry = require('prismarine-registry')
const mcChunk = require('prismarine-chunk')
const mcBlock = require('prismarine-block')
const mcWorld = require('prismarine-world')

// ============================================================================
// simpleUtils
// ============================================================================

function getBufferFromStream(stream) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.from([])
    stream.on('data', (buf) => {
      buffer = Buffer.concat([buffer, buf])
    })
    stream.on('end', () => resolve(buffer))
    stream.on('error', reject)
  })
}

function spiral(X, Y, fun) {
  let x = 0
  let y = 0
  let dx = 0
  let dy = -1
  const N = Math.max(X, Y) * Math.max(X, Y)
  const hX = X / 2
  const hY = Y / 2
  for (let i = 0; i < N; i++) {
    if (-hX < x && x <= hX && -hY < y && y <= hY) {
      fun(x, y)
    }
    if (x === y || (x < 0 && x === -y) || (x > 0 && x === 1 - y)) {
      const tmp = dx
      dx = -dy
      dy = tmp
    }
    x += dx
    y += dy
  }
}

class ViewRect {
  constructor(cx, cz, viewDistance) {
    this.x0 = cx - viewDistance
    this.x1 = cx + viewDistance
    this.z0 = cz - viewDistance
    this.z1 = cz + viewDistance
  }

  contains(x, z) {
    return this.x0 < x && x <= this.x1 && this.z0 < z && z <= this.z1
  }
}

function chunkPos(pos) {
  const x = Math.floor(pos.x / 16)
  const z = Math.floor(pos.z / 16)
  return [x, z]
}

// ============================================================================
// BlockConverter
// ============================================================================

class BlockConverter {
  constructor(javaVersion, bot) {
    this.javaVersion = javaVersion
    this.javaMcData = mcData(javaVersion)
    this.javaRegistry = mcRegistry(javaVersion)
    this.JavaChunkColumn = mcChunk(this.javaRegistry)
    const javaWorldConstructor = mcWorld(javaVersion)
    this.javaWorld = new javaWorldConstructor(undefined, null, 0)
    this.Block = mcBlock(this.javaRegistry)
    this.BedrockBlock = mcBlock(bot.registry)
    this.bot = bot
    this.stateCache = new Map()

    // Build B2J mapping: normalizedBedrockStateStr -> javaStateId
    this.blocksB2J = {}
    const blocksJ2B = bot.registry.blocksJ2B
    if (blocksJ2B) {
      for (const javaStateStr in blocksJ2B) {
        const bedrockStateStr = blocksJ2B[javaStateStr]

        if(javaStateStr.includes('golden_dandelion')){
          continue;
        }

        //const normalizedBedrock = this.normalizeStateString(bedrockStateStr)
        const javaStateId = this.Block.fromString(javaStateStr).stateId
        const bedrock = this.BedrockBlock.fromString(bedrockStateStr);
        if (javaStateId !== undefined) {
          this.blocksB2J[bedrock.stateId ?? bedrock.defaultState] = [...this.blocksB2J[bedrock.stateId ?? bedrock.defaultState] ??[], javaStateId]
          
        }else{
          console.log(notFound)
        }
      }
    }
  }

  // Normalize state string: sort properties alphabetically
  normalizeStateString(stateStr) {
    const match = stateStr.match(/^([^\[]+)(?:\[([^\]]*)\])?$/)
    if (!match) return stateStr

    const name = match[1]
    if (!match[2]) return `${name}[]`

    const props = {}
    match[2].split(',').forEach(pair => {
      const [key, value] = pair.split('=')
      if (key && value !== undefined) {
        props[key.trim()] = value.trim()
      }
    })

    const keys = Object.keys(props).sort()
    const propsStr = keys.map(k => `${k}=${props[k]}`).join(',')
    return `${name}[${propsStr}]`
  }

  // Parse "minecraft:block_name[prop1=val1,prop2=val2]" and return stateId
  javaStateStrToId(stateStr) {
    const match = stateStr.match(/^minecraft:([^\[]+)(?:\[([^\]]*)\])?$/)
    if (!match) return undefined

    const blockName = match[1]
    const javaBlock = this.javaMcData.blocksByName[blockName]
    if (!javaBlock) return undefined

    // No states - return default
    if (!javaBlock.states || javaBlock.states.length === 0) {
      return javaBlock.defaultState
    }

    // Parse properties
    const props = {}
    if (match[2]) {
      match[2].split(',').forEach(pair => {
        const [key, value] = pair.split('=')
        if (key && value !== undefined) {
          props[key.trim()] = value.trim()
        }
      })
    }

    // Calculate state offset
    let offset = 0
    let multiplier = 1

    for (let i = javaBlock.states.length - 1; i >= 0; i--) {
      const state = javaBlock.states[i]
      const value = props[state.name]
      let valueIndex = 0

      if (state.values) {
        valueIndex = state.values.indexOf(String(value))
        if (valueIndex === -1) valueIndex = 0
      } else if (state.type === 'bool') {
        valueIndex = value === 'true' ? 0 : 1
      } else if (state.type === 'int') {
        valueIndex = Number(value) || 0
      }

      offset += valueIndex * multiplier
      multiplier *= state.num_values || state.values?.length || 2
    }

    return javaBlock.minStateId + offset
  }

  buildBedrockStateString(blockName, bedrockProps) {
    const props = {}
    for (const key in bedrockProps) {
      const prop = bedrockProps[key]
      props[key] = prop.value !== undefined ? prop.value : prop
    }
    const keys = Object.keys(props).sort()
    const propsStr = keys.map(k => `${k}=${props[k]}`).join(',')
    return `minecraft:${blockName}[${propsStr}]`
  }

  getJavaStateIdAt(pos) {
    const bedrockStateId = this.bot.world.getBlockStateId(pos)
    return this.getJavaStateId(bedrockStateId)
  }

  getJavaBlockByBedrockId(bedrockStateId) {
    const stateId = this.getJavaStateId(bedrockStateId)
    const block = this.Block.fromStateId(stateId, 0)
    return block
  }

  getJavaStateId(bedrockStateId) {
    const javaIds =this.blocksB2J[bedrockStateId];
    if(javaIds && javaIds.length > 0){
      return javaIds[0]
    }


    // Check cache first
    if (this.stateCache.has(bedrockStateId)) {
      return this.stateCache.get(bedrockStateId)
    }

    const bedrockBlock = this.bot.registry.blocksByStateId[bedrockStateId]
    if (!bedrockBlock) {
      return 0
    }

    // Get Bedrock state properties
    const bedrockState = this.bot.registry.blockStates?.[bedrockStateId]
    const bedrockProps = bedrockState?.states || {}

    // Build Bedrock state string and lookup in B2J map
    const bedrockStateStr = this.buildBedrockStateString(bedrockBlock.name, bedrockProps)
    const javaStateId = this.blocksB2J[bedrockStateStr]

    if (javaStateId !== undefined) {
      this.stateCache.set(bedrockStateId, javaStateId)
      return javaStateId
    }

    // Fallback: try to find Java block by name and return default state
    const javaBlock = this.javaMcData.blocksByName[bedrockBlock.name]
    if (javaBlock) {
      this.stateCache.set(bedrockStateId, javaBlock.defaultState)
      return javaBlock.defaultState
    }

    // Block doesn't exist in Java
    this.stateCache.set(bedrockStateId, 0)
    return 0
  }

  convertColumn(column) {
    const chunk = new this.JavaChunkColumn({})
    for (let y = -64; y < 225; y++) {
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          const posInChunk = new Vec3(x, y, z)
          let bedrockStateId = column.getBlockStateId(posInChunk)
          if (bedrockStateId != null) {
            let javaStateId = this.getJavaStateId(bedrockStateId)
            chunk.setBlockStateId(posInChunk, javaStateId)
          }
        }
      }
    }
    return chunk
  }

  /**
   * Apply per-state collision shapes for Bedrock dynamic blocks (fences, panes, stairs, chorus)
   * This calculates neighbor-dependent shapes at runtime
   * Note: This is primarily for physics/pathfinding - viewer rendering doesn't need this
   */
  applyDynamicCollisionShapes(block) {
    const collisionShapes = this.bot.registry.blockCollisionShapes
    const blockType = this.bot.registry.blocks[block.type]

    if (blockType?.shapeType == null) return block

    const dynamicShapes = collisionShapes?.dynamicShapes?.[blockType.shapeType]
    if (!dynamicShapes) return block

    // Use bot.blockAt to get block with shapes already calculated
    const blockWithShapes = this.bot.blockAt(block.position)
    if (blockWithShapes?.shapes) {
      block.shapes = blockWithShapes.shapes
    }

    return block
  }
}

// ============================================================================
// WorldView
// ============================================================================

class WorldView extends EventEmitter {
  constructor(world, blockConverter, viewDistance, position = new Vec3(0, 0, 0), emitter = null) {
    super()
    this.world = world
    this.viewDistance = viewDistance
    this.blockConverter = blockConverter
    this.loadedChunks = {}
    this.lastPos = new Vec3(0, 0, 0).update(position)
    this.emitter = emitter ?? this

    this.listeners = {}
    this.emitter.on('mouseClick', async (click) => {
      try {
        const ori = new Vec3(click.origin.x, click.origin.y, click.origin.z)
        const dir = new Vec3(click.direction.x, click.direction.y, click.direction.z)
        const bedrockBlock = await this.world.raycast(ori, dir, 256)
        if (!bedrockBlock) return
        const javaBlock = this.blockConverter.getJavaBlockByBedrockId(bedrockBlock.stateId)
        javaBlock.position = bedrockBlock.position
        this.emit('blockClicked', javaBlock, bedrockBlock.face, click.button)
      } catch (err) {
        // raycast can throw if it walks into an unloaded chunk
        // (prismarine-world's getBlock calls .getBlock on the result of
        // getColumnAt without null-checking). A click into unloaded space
        // is a no-op.
        console.warn('[viewer] mouseClick raycast failed:', err.message)
      }
    })

    this.emitter.on('gamepad', async (state) => {
      this.emit('gamepad', state)
    })
  }

  listenToBot(bot) {
    const worldView = this
    this.listeners[bot.username] = {
      entitySpawn: function (e) {
        if (e === bot.self) return
        worldView.emitter.emit('entity', {
          id: e.id,
          name: e.name,
          pos: e.position,
          width: e.width,
          height: e.height,
          username: e.username
        })
      },
      entityMoved: function (e) {
        worldView.emitter.emit('entity', { id: e.id, pos: e.position, pitch: e.pitch, yaw: e.yaw })
      },
      entityGone: function (e) {
        worldView.emitter.emit('entity', { id: e.id, delete: true })
      }
    }

    bot.world.on('chunkColumnLoad', (pos)=>{
      worldView.loadChunk(pos);
    })
    
    bot.world.on('blockUpdate', (oldBlock, newBlock) => {
      const stateId = newBlock.stateId ? newBlock.stateId : (newBlock.type << 4) | newBlock.metadata
      const javaState = this.blockConverter.getJavaStateId(stateId)
      
      worldView.emitter.emit('blockUpdate', { pos: oldBlock.position, stateId: javaState })
    })

    for (const [evt, listener] of Object.entries(this.listeners[bot.username])) {
      bot.on(evt, listener)
    }

    for (const id in bot.entities) {
      const e = bot.entities[id]
      if (e && e !== bot.self) {
        this.emitter.emit('entity', {
          id: e.id,
          name: e.name,
          pos: e.position,
          width: e.width,
          height: e.height,
          username: e.username
        })
      }
    }
  }

  removeListenersFromBot(bot) {
    for (const [evt, listener] of Object.entries(this.listeners[bot.username])) {
      bot.removeListener(evt, listener)
    }
    delete this.listeners[bot.username]
  }

  async init(pos) {
    const [botX, botZ] = chunkPos(pos)

    const positions = []
    spiral(this.viewDistance * 2, this.viewDistance * 2, (x, z) => {
      const p = new Vec3((botX + x) * 16, 0, (botZ + z) * 16)
      positions.push(p)
    })

    this.lastPos.update(pos)
    await this._loadChunks(positions)
  }

  async _loadChunks(positions, sliceSize = 5, waitTime = 0) {
    for (let i = 0; i < positions.length; i += sliceSize) {
      await new Promise((resolve) => setTimeout(resolve, waitTime))
      await Promise.all(positions.slice(i, i + sliceSize).map((p) => this.loadChunk(p)))
    }
  }

  async loadChunk(pos) {
    const [botX, botZ] = chunkPos(this.lastPos)
    const dx = Math.abs(botX - Math.floor(pos.x / 16))
    const dz = Math.abs(botZ - Math.floor(pos.z / 16))
    if (dx < this.viewDistance && dz < this.viewDistance) {
      const column = await this.world.getColumnAt(pos)
      if (column) {
        const javaColumn = this.blockConverter.convertColumn(column)
        const javaChunk = javaColumn.toJson()
        this.emitter.emit('loadChunk', { x: pos.x, z: pos.z, chunk: javaChunk })
        this.loadedChunks[`${pos.x},${pos.z}`] = true
      }
    }
  }

  unloadChunk(pos) {
    this.emitter.emit('unloadChunk', { x: pos.x, z: pos.z })
    delete this.loadedChunks[`${pos.x},${pos.z}`]
  }

  async updatePosition(pos, force = false) {
    const [lastX, lastZ] = chunkPos(this.lastPos)
    const [botX, botZ] = chunkPos(pos)
    if (lastX !== botX || lastZ !== botZ || force) {
      const newView = new ViewRect(botX, botZ, this.viewDistance)
      for (const coords of Object.keys(this.loadedChunks)) {
        const x = parseInt(coords.split(',')[0])
        const z = parseInt(coords.split(',')[1])
        const p = new Vec3(x, 0, z)
        if (!newView.contains(Math.floor(x / 16), Math.floor(z / 16))) {
          this.unloadChunk(p)
        }
      }
      const positions = []
      spiral(this.viewDistance * 2, this.viewDistance * 2, (x, z) => {
        const p = new Vec3((botX + x) * 16, 0, (botZ + z) * 16)
        if (!this.loadedChunks[`${p.x},${p.z}`]) {
          positions.push(p)
        }
      })
      this.lastPos.update(pos)
      await this._loadChunks(positions)
    } else {
      this.lastPos.update(pos)
    }
  }
}

// ============================================================================
// Main plugin
// ============================================================================

// socket.io-shaped wrapper around a `ws` WebSocket so call sites that expect
// `.on(evt, fn)` for inbound and `.emit(evt, data)` for outbound keep working.
// Wire envelope: `{ event, data }` JSON per text frame.
function socketShim(ws) {
  const inbound = new EventEmitter()
  ws.on('message', (data) => {
    try {
      const { event, data: payload } = JSON.parse(data.toString('utf8'))
      inbound.emit(event, payload)
    } catch (err) {
      console.warn('[viewer] bad client frame:', err.message)
    }
  })
  ws.on('close', () => inbound.emit('disconnect'))
  ws.on('error', (err) => console.warn('[viewer] ws error:', err.message))
  return {
    on: (e, fn) => inbound.on(e, fn),
    emit: (e, data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: e, data }))
    },
    disconnect: () => ws.close()
  }
}

module.exports = (bot, { viewDistance = 6, firstPerson = false, port = 3000, prefix = '', javaVersion = '1.21.11', stickSensitivity = 1, pitchSensitivity = 0.5, maxCameraDistance = 30 }) => {
  BigInt.prototype.toJSON = function () {
    return this.toString()
  }

  const http = require('http')
  const { WebSocketServer } = require('ws')

  const httpServer = http.createServer((req, res) => {
    const url = req.url || '/'
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(
        'Bot viewer running. Open the GH Pages client:\n' +
        '  https://mc-zuri.github.io/node-prismarine-viewer/\n' +
        '(defaults to http://localhost:3000; for a non-default host use ?server=' + encodeURIComponent('http://' + req.headers.host) + ')'
      )
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    }
  })

  const wss = new WebSocketServer({ server: httpServer, path: prefix + '/socket.io' })

  const blockConverter = new BlockConverter(javaVersion, bot)

  const sockets = []
  const primitives = {}

  bot.viewer = new EventEmitter()

  bot.viewer.erase = (id) => {
    delete primitives[id]
    for (const socket of sockets) {
      socket.emit('primitive', { id })
    }
  }

  bot.viewer.drawBoxGrid = (id, start, end, color = 'aqua') => {
    primitives[id] = { type: 'boxgrid', id, start, end, color }
    for (const socket of sockets) {
      socket.emit('primitive', primitives[id])
    }
  }

  bot.viewer.drawLine = (id, points, color = 0xff0000) => {
    primitives[id] = { type: 'line', id, points, color }
    for (const socket of sockets) {
      socket.emit('primitive', primitives[id])
    }
  }

  bot.viewer.drawPoints = (id, points, color = 0xff0000, size = 5) => {
    primitives[id] = { type: 'points', id, points, color, size }
    for (const socket of sockets) {
      socket.emit('primitive', primitives[id])
    }
  }

  // bot.self.position is the EYE position in prismarine-bedrock. The Java
  // viewer protocol expects feet position, so subtract the entity's eye
  // height (pose-dependent: 1.62 standing, 1.27 sneaking, etc.).
  function feetPosition () {
    const eye = bot.self.eyeHeight ?? 1.62
    return new Vec3(bot.self.position.x, bot.self.position.y - eye, bot.self.position.z)
  }

  bot.on('path_update', (r) => {
    const path = [feetPosition().offset(0, 0.5, 0)]
    for (const node of r.path) {
      path.push(new Vec3(node.x, node.y + 0.5, node.z))
    }
    bot.viewer.drawLine('path', path, 0xff00ff)
  })

  bot.on('path_reset', () => {
    bot.viewer.erase('path')
  })

  bot.on('goal_reached', () => {
    bot.viewer.erase('path')
  })

  wss.on('connection', (ws) => {
    const socket = socketShim(ws)
    socket.emit('version', blockConverter.javaVersion)
    socket.emit('config', { stickSensitivity, pitchSensitivity, firstPerson, maxCameraDistance })
    sockets.push(socket)

    const initialFeet = feetPosition()
    const worldView = new WorldView(bot.world, blockConverter, viewDistance, initialFeet, socket)
    worldView.init(initialFeet)

    worldView.on('blockClicked', (block, face, button) => {
      bot.viewer.emit('blockClicked', block, face, button)
    })

    worldView.on('gamepad', (state) => {
      bot.viewer.emit('gamepad', state)
    })

    for (const id in primitives) {
      socket.emit('primitive', primitives[id])
    }

    let pos = new Vec3(0, 0, 0)
    let yaw = 0, pitch = 0;
    function botPosition() {
      if (bot.self.position.x === pos.x && bot.self.position.y === pos.y && bot.self.position.z === pos.z && bot.self.yaw == yaw && bot.self.pitch == pitch) {
        return
      }

      yaw = bot.self.yaw;
      pitch = bot.self.pitch;

      const feet = feetPosition()
      const packet = {
        pos: feet,
        yaw: Math.PI - (bot.self.yaw ?? 180) * Math.PI / 180,
        addMesh: true,
        pitch: undefined
      }
      if (firstPerson) {
        packet.pitch = -(bot.self.pitch ?? 0) * Math.PI / 180
      }
      socket.emit('position', packet)
      worldView.updatePosition(feet)
      pos.set(bot.self.position.x, bot.self.position.y, bot.self.position.z)
    }

    bot.on('move', botPosition)
      setInterval(()=>botPosition(), 50)
    worldView.listenToBot(bot)
    socket.on('disconnect', () => {
      bot.removeListener('move', botPosition)
      worldView.removeListenersFromBot(bot)
      sockets.splice(sockets.indexOf(socket), 1)
    })
  })



  httpServer.listen(port, () => {
    console.log(`Prismarine viewer web server running on *:${port}`)
    const os = require('os')
    const ips = ['127.0.0.1']
    for (const name in os.networkInterfaces()) {
      for (const iface of os.networkInterfaces()[name]) {
        if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
      }
    }
    console.log('Open viewer:')
    for (const ip of ips) {
      console.log(`  https://mc-zuri.github.io/node-prismarine-viewer/?server=http://${ip}:${port}`)
    }
  })

  bot.viewer.close = () => {
    httpServer.close()
    for (const socket of sockets) {
      socket.disconnect()
    }
  }
}

// Export classes for external use
module.exports.BlockConverter = BlockConverter
module.exports.WorldView = WorldView
