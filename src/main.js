process.env.DEBUG_PHYSICS = true
const { BotState, bedrockVersionFromEnv } = require('bedrock-test')
const Vec3 = require('vec3').Vec3
const pViewer = require("prismarine-viewer");

const options = {
  host: 'localhost',
  port: 19132,
  username: 'MyBot',
  offline: true,
  version: bedrockVersionFromEnv()
}

const botState = new BotState(options)
botState.start();
addMissingPacketHandlers(botState);

botState.client.once("start_game", () => {
    pViewer.prismarineBedrock(botState, {
      firstPerson: false,
      javaVersion: "1.21.11",
      port: 3000,
      viewDistance: 10,
    });

    botState.viewer.on("gamepad", (state) => {
      botState.setControlState("back", state.controlsState.back);
      botState.setControlState("forward", state.controlsState.forward);
      botState.setControlState("right", state.controlsState.right);
      botState.setControlState("left", state.controlsState.left);
      botState.setControlState("jump", state.controlsState.jump);
      botState.setControlState("sneak", state.controlsState.sneak);
      botState.cameraState = state.camera;
    });

    botState.viewer.on("blockClicked", (block, face, button) => {
      const target = block.position;
      const dx = target.x - botState.self.position.x
      const dy = target.y - botState.self.position.y
      const dz = target.z - botState.self.position.z
      const dist = Math.sqrt(dx * dx + dz * dz)
      const yaw = Math.atan2(dx, -dz) * (180 / Math.PI)
      const pitch = -Math.atan2(dy, dist) * (180 / Math.PI)
      botState.look(yaw, pitch)
    });

    setInterval(()=>{
      botState.emit('move', botState.self.position.clone())
    }, 50)
});

function addMissingPacketHandlers(botState){    
  botState.client.on('available_commands', (x)=>{
    botState.client.queue('serverbound_loading_screen', {
      type: 1,
    });
    botState.client.queue('serverbound_loading_screen', {
      type: 2,
    });
    botState.client.queue('interact', {
        action_id: 'mouse_over_entity',
        target_entity_id: 0n,
        position: {
            x: 0,
            y: 0,
            z: 0,
        },
        has_position: false,
    });
    botState.client.queue('set_local_player_as_initialized', {
        runtime_entity_id: `${botState.self.runtimeId}`,
    });
  })
}