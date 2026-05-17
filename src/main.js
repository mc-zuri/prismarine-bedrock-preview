process.env.DEBUG_PHYSICS = true
const { BotState, bedrockVersionFromEnv } = require('bedrock-test')
const Vec3 = require('vec3').Vec3
const prismarineBedrock = require('./viewer-server');

const options = {
  host: 'localhost',
  port: 19132,
  username: 'MyBot',
  offline: true,
  version: bedrockVersionFromEnv()
}

const botState = new BotState(options)
botState.start();

botState.client.once("start_game", () => {
    prismarineBedrock(botState, {
      firstPerson: false,
      javaVersion: "1.21.11",
      port: 3000,
      viewDistance: 4,
      stickSensitivity: 0.5,
      maxCameraDistance: 10,   // ← any number; default 30
    });

    botState.viewer.on("gamepad", (state) => {
      botState.setControlState("forward", state.controlsState.forward);
      botState.setControlState("back",    state.controlsState.back);
      botState.setControlState("left",    state.controlsState.left);
      botState.setControlState("right",   state.controlsState.right);
      botState.setControlState("jump",    state.controlsState.jump);
      botState.setControlState("sneak",   state.controlsState.sneak);
      botState.setControlState("sprint",  state.controlsState.sprint);

      const { pitch: dPitch, yaw: dYaw } = state.camera;
      if (dPitch || dYaw) {
        const RAD2DEG = 180 / Math.PI;
        const newYaw   = botState.self.yaw   - dYaw   * RAD2DEG;
        const newPitch = Math.max(-89.9, Math.min(89.9, botState.self.pitch - dPitch * RAD2DEG));
        botState.look(newYaw, newPitch);
      }
    });

    botState.viewer.on("blockClicked", (block, face, button) => {
      const target = block.position.offset(0.5, 0.5, 0.5)
      botState.lookAt(target)
      const p = botState.self.position
    });

    setInterval(()=>{
      botState.emit('move', botState.self.position.clone())
    }, 50)
});