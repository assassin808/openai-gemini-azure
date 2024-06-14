const express = require('express');
const { Buffer } = require('node:buffer');
// alt: import { base64url } from "rfc4648";

const app = express();
const port = 3000; // Choose your desired port

app.post('/v1/chat/completions', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`); // Construct full URL
  if (!url.pathname.endsWith('/v1/chat/completions') || req.method !== 'POST') {
    return res.status(404).send('404 Not Found');
  }

  const auth = req.headers.get('Authorization');
  let apiKey = auth && auth.split(' ')[1];
  if (!apiKey) {
    return res.status(401).send('Bad credentials');
  }

  let json;
  try {
    json = req.body; // Assuming you are using a body-parser middleware
    if (!Array.isArray(json.messages)) {
      throw SyntaxError('.messages array required');
    }
  } catch (err) {
    console.error(err.toString());
    return res.status(400).send(err.toString());
  }

  handleRequest(json, apiKey, res); // Pass the response object (res)
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

// ... (Rest of the functions: handleOPTIONS, handleRequest, etc.)

const handleOPTIONS = async () => {
  return {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    },
  };
};

const BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';
const API_CLIENT = 'genai-js/0.5.0'; 

async function handleRequest(req, apiKey, res) { 
  let model = 'gpt-3.5';
  try {
    model = req.model || model;
  } catch (error) {
    console.error('Error parsing request body:', error);
  }

  let MODEL;
  if (model.includes('gpt-4')) {
    MODEL = 'gemini-1.5-pro-latest';
  } else {
    MODEL = 'gemini-1.5-flash-latest';
  }

  const TASK = req.stream ? 'streamGenerateContent' : 'generateContent';
  let url = `${BASE_URL}/${API_VERSION}/models/${MODEL}:${TASK}`;
  if (req.stream) {
    url += '?alt=sse';
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'x-goog-api-client': API_CLIENT,
      },
      body: JSON.stringify(await transformRequest(req)),
    });

    const headers = { 'Access-Control-Allow-Origin': '*' }; // Start with basic headers

    if (response.ok) {
      let id = generateChatcmplId();
      if (req.stream) {
        // ... (Streaming response handling - remains similar, 
        // but instead of returning a new Response, you'll pipe 
        // the transformed data to 'res' using 'res.write()') 
      } else {
        let body = await response.text();
        try {
          body = await processResponse(JSON.parse(body).candidates, MODEL, id);
        } catch (err) {
          console.error(err);
          return res.status(500).send(err.toString());
        }
        // Set Content-Type for successful non-streaming responses
        headers['Content-Type'] = 'application/json'; 
        res.writeHead(200, headers);
        res.end(body);
      }
    } else {
      let body = await response.text();
      try {
        const { code, status, message } = JSON.parse(body).error;
        body = `Error: [${code} ${status}] ${message}`;
      } catch (err) {
        // Pass body as is
      }
      headers['Content-Type'] = 'text/plain';
      res.status(response.status).send(body);
    }
  } catch (err) {
    console.error(err);
    res.status(400).send(err.toString());
  }
}

// ... (Previous code from the last response)

async function transformRequest(req) {
  const prompt = req.messages
    .map((m) => (m.role === 'user' ? `${m.content}` : `[Assistant] ${m.content}`))
    .join('\n');

  const messages = req.messages.map((message) => {
    if (message.content !== undefined) {
      return {
        content: message.content,
      };
    } else if (message.function_call) {
      return {
        function_call: message.function_call,
      };
    } else {
      throw new Error('Invalid message object');
    }
  });

  const temperature = req.temperature !== undefined ? req.temperature : 0.7;
  const topP = req.top_p !== undefined ? req.top_p : 1;
  const topK = req.top_k !== undefined ? req.top_k : 40;

  return {
    prompt: {
      text: prompt,
    },
    temperature: temperature,
    top_p: topP,
    top_k: topK,
  };
}

function generateChatcmplId() {
  const buffer = Buffer.alloc(16);
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
  // or
  // const buffer = randomBytes(16);
  return (
    Date.now().toString(36) +
    '-' +
    buffer.toString('hex')
  );
}

async function processResponse(candidates, model, id) {
  if (!candidates || candidates.length === 0) {
    throw new Error('No candidates found in response');
  }

  const response = {
    id: `chatcmpl-${id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), // Current timestamp in seconds
    model: model,
    choices: candidates.map((c) => ({
      index: 0,
      message: {
        role: 'assistant',
        content: c.content,
      },
      finish_reason: 'stop',
    })),
  };

  return JSON.stringify(response, null, 2);
}

// Streaming Functions

function parseStream(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();

      // Split the buffer by the delimiter (new line)
      const parts = buffer.split('\n');

      // Process all complete messages
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].startsWith('data: ')) {
          const data = JSON.parse(parts[i].substring(6));
          if (data.choices && data.choices[0].delta) {
            // Check if it's not a heartbeat signal
            if (data.choices[0].delta.content) {
              resolve(data);
            }
          }
        }
      }

      // Keep the last (possibly incomplete) message in the buffer
      buffer = parts[parts.length - 1];
    });

    stream.on('end', () => {
      resolve(null); // Signal end of stream
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

function parseStreamFlush(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();

      // Split the buffer by the delimiter (new line)
      const parts = buffer.split('\n');

      // Process all complete messages
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].startsWith('data: ')) {
          const data = JSON.parse(parts[i].substring(6));
          if (data.choices && data.choices[0].finish_reason) {
            resolve(data);
          }
        }
      }

      // Keep the last (possibly incomplete) message in the buffer
      buffer = parts[parts.length - 1];
    });

    stream.on('end', () => {
      resolve(null); // Signal end of stream
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

function transformResponseStream(data) {
  if (data.choices && data.choices[0].delta) {
    return `data: ${JSON.stringify({
      id: data.id,
      object: 'chat.completion.chunk',
      created: data.created,
      model: data.model,
      choices: [
        {
          delta: {
            content: data.choices[0].delta.content,
          },
        },
      ],
    })}\n\n`;
  }
}

function toOpenAiStream(data) {
  if (data.choices && data.choices[0].finish_reason) {
    return `data: ${JSON.stringify({
      id: data.id,
      object: 'chat.completion.chunk',
      created: data.created,
      model: data.model,
      choices: [
        {
          delta: {}, // Empty delta for the final chunk
          finish_reason: data.choices[0].finish_reason,
        },
      ],
    })}\n\n`;
  }
}

function toOpenAiStreamFlush() {
  return 'data: [DONE]\n\n';
}

// ... (Rest of your code, including the Express server setup)

