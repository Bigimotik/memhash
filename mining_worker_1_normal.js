self.onmessage = function (event) {
  const data = JSON.parse(event.data);

  if (data.turboMode !== undefined) {
    // Handle turbo mode toggle
    isTurboMode = data.turboMode;
    return;
  }

  if (data.startNonce !== undefined && data.endNonce !== undefined) {
    // Received a new nonce range
    startNonce = data.startNonce;
    endNonce = data.endNonce;

    // Start processing if not already doing so
    if (!isProcessing) {
      isProcessing = true;
      processNonceRanges();
    } else {
      // New range received while processing; queue it
      nonceRanges.push({ startNonce, endNonce });
    }
  } else {
    // Received initial task data or updated task data
    if (taskData !== null) {
      // Task data is being updated during processing
      // Set flag to indicate task data has been updated
      taskDataUpdated = true;
      // Update taskData
      taskData = data;
    } else {
      // Initial task data
      taskData = data;
    }
  }
};

let taskData = null;
let isProcessing = false;
let nonceRanges = [];
let startNonce = 0;
let endNonce = 0;
let taskDataUpdated = false;

// Thermal management state
let hashesProcessed = 0;
let lastMeasurement = Date.now();
let baselineHashRate = null;
let needsCooldown = false;
let isTurboMode = false;
const MEASURE_INTERVAL = 2000; // Check every 2 seconds
const COOLDOWN_TIME = 1000;    // 1 second cooldown when needed
const HASH_THRESHOLD = 0.7;    // Throttle at 70% performance drop

async function processNonceRanges() {
  while (true) {
    if (taskDataUpdated) {
      nonceRanges = [];
      startNonce = 0;
      endNonce = 0;
      taskDataUpdated = false;
      postMessage('requestRange');
      await new Promise((resolve) => {
        const handler = function (event) {
          const data = JSON.parse(event.data);
          if (data.startNonce !== undefined && data.endNonce !== undefined) {
            startNonce = data.startNonce;
            endNonce = data.endNonce;
            self.removeEventListener('message', handler);
            resolve();
          }
        };
        self.addEventListener('message', handler);
      });
      continue;
    }

    let result = await processNonceRange(taskData, startNonce, endNonce);
    if (result) {
      postMessage(JSON.stringify(result));
      break;
    } else {
      if (nonceRanges.length > 0) {
        const nextRange = nonceRanges.shift();
        startNonce = nextRange.startNonce;
        endNonce = nextRange.endNonce;
      } else {
        postMessage('requestRange');
        await new Promise((resolve) => {
          const handler = function (event) {
            const data = JSON.parse(event.data);
            if (data.startNonce !== undefined && data.endNonce !== undefined) {
              startNonce = data.startNonce;
              endNonce = data.endNonce;
              self.removeEventListener('message', handler);
              resolve();
            }
          };
          self.addEventListener('message', handler);
        });
      }
    }
  }
}

async function checkThermal() {
  if (isTurboMode) return; // Skip thermal management in turbo mode

  hashesProcessed++;
  const now = Date.now();

  if (now - lastMeasurement >= MEASURE_INTERVAL) {
    const currentHashRate = (hashesProcessed * 1000) / (now - lastMeasurement);

    if (!baselineHashRate) {
      baselineHashRate = currentHashRate;
    } else {
      const performanceRatio = currentHashRate / baselineHashRate;
      needsCooldown = performanceRatio < HASH_THRESHOLD;
    }

    hashesProcessed = 0;
    lastMeasurement = now;
  }

  if (needsCooldown) {
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_TIME));
    needsCooldown = false;
  }
}

async function processNonceRange(task, startNonce, endNonce) {
  let nonce = startNonce;

  while (nonce < endNonce) {
    if (taskDataUpdated) {
      return null;
    }

    await checkThermal();

    const timestamp = Date.now();
    const hash = await calculateHashGPU(
      task.index,
      task.previousHash,
      task.data,
      nonce,
      timestamp,
      task.minerId
    );

    const validState = isValidBlock(hash, task.mainFactor, task.shareFactor);
    if (validState === 'valid') {
      return {
        state: 'valid',
        hash: hash,
        data: task.data,
        nonce: nonce,
        timestamp: timestamp,
        minerId: task.minerId,
      };
    } else if (validState === 'share') {
      postMessage(
        JSON.stringify({
          state: 'share',
          hash: hash,
          data: task.data,
          nonce: nonce,
          timestamp: timestamp,
          minerId: task.minerId,
        })
      );
    }

    nonce += 1;
  }

  return null;
}

async function calculateHashGPU(index, previousHash, data, nonce, timestamp, minerId) {
  const input = `${index}-${previousHash}-${data}-${nonce}-${timestamp}-${minerId}`;
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(input);

  // Initialize WebGL
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl');

  if (!gl) {
    console.error('WebGL not supported');
    return null;
  }

  const vertexShaderSource = `
    attribute vec4 a_position;
    void main() {
      gl_Position = a_position;
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;
    uniform sampler2D u_data;
    void main() {
      vec4 color = texture2D(u_data, gl_FragCoord.xy / vec2(256.0, 256.0));
      gl_FragColor = color;
    }
  `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = createProgram(gl, vertexShader, fragmentShader);

  gl.useProgram(program);

  // Set up the data texture
  const dataTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, dataTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  // Set up the framebuffer
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dataTexture, 0);

  // Set up the vertex data
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  const positions = [
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1,
  ];
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  const positionLocation = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  // Set up the data texture
  const dataLocation = gl.getUniformLocation(program, 'u_data');
  gl.uniform1i(dataLocation, 0);

  // Render the data texture
  gl.viewport(0, 0, 256, 256);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // Read the data texture
  const pixels = new Uint8Array(256 * 256 * 4);
  gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // Convert the pixels to a hash
  const hashArray = Array.from(pixels.subarray(0, 32));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

function isValidBlock(hash, mainFactor, shareFactor) {
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]+$/.test(hash)) {
    console.error('Invalid hash value:', hash);
    return 'notValid';
  }

  const value = BigInt('0x' + hash);
  const mainFactorBigInt = BigInt(mainFactor);
  const shareFactorBigInt = BigInt(shareFactor);

  if (value < mainFactorBigInt) {
    return 'valid';
  } else if (value < shareFactorBigInt) {
    return 'share';
  } else {
    return 'notValid';
  }
}
