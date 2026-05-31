import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { createCloudRecordingService } from "../cloud/cloudRecordingService.js";
import { createAuthTokenService } from "../cloud/authTokenService.js";
import { createLocalDevObjectStorage } from "../cloud/localDevObjectStorage.js";
import { createMemoryMetadataRepository } from "../cloud/memoryMetadataRepository.js";
import { processNextRecordingValidationJob } from "../cloud/validationWorker.js";
import { createInterviewRoomService } from "../interview/interviewRoomService.js";
import { createMemoryInterviewRoomRepository } from "../interview/memoryInterviewRoomRepository.js";
import { createApiHandler } from "../http/createApiHandler.js";
import { createCloudApiHandler, type CloudApiHandler } from "../http/cloudApiHandler.js";
import { createInterviewApiHandler } from "../http/interviewApiHandler.js";
import { createLocalDevObjectStorageHandler } from "../http/localDevObjectStorageHandler.js";
import { createInterviewSignalingServer } from "../signaling/interviewSignalingServer.js";
import { createInterviewWebSocketUpgradeHandler } from "../signaling/interviewWebSocketUpgradeHandler.js";

export type DemoRequestHandlerOptions = {
  webRoot: string;
  publicBaseUrl?: string;
  createRequestId?: () => string;
};

export type DemoRuntime = {
  handler: CloudApiHandler;
  server: Server;
  close(): void;
};

export function createDemoRequestHandler(options: DemoRequestHandlerOptions): CloudApiHandler {
  return createDemoRuntime(options).handler;
}

export function createDemoRuntime(options: DemoRequestHandlerOptions): DemoRuntime {
  const webRoot = resolve(options.webRoot);
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createLocalDevObjectStorage({
    publicBaseUrl: options.publicBaseUrl ?? "",
  });
  const cloud = createCloudApiHandler({
    service: createCloudRecordingService({ metadata, objectStorage }),
    auth: createAuthTokenService({ secret: process.env.CODE_TAPE_AUTH_SECRET }),
    createRequestId: options.createRequestId,
  });
  const rooms = createInterviewRoomService({
    rooms: createMemoryInterviewRoomRepository(),
  });
  const signaling = createInterviewSignalingServer({ rooms });
  const api = createApiHandler({
    cloud,
    interview: createInterviewApiHandler({
      rooms,
      createRequestId: options.createRequestId,
      onRoomEnded: signaling.notifyRoomEnded,
    }),
    objectStorage: createLocalDevObjectStorageHandler(objectStorage),
  });
  const upgrade = createInterviewWebSocketUpgradeHandler({ signaling });

  const handler: CloudApiHandler = async (request) => {
    const url = new URL(request.url);
    if (isDemoApiPath(url.pathname)) {
      const response = await api(request);
      if (response.ok && isCompleteUploadRequest(request.method, url.pathname)) {
        await processNextRecordingValidationJob({ metadata, objectStorage });
      }
      return response;
    }
    return serveStatic({ request, webRoot });
  };

  const server = createServer((incoming, outgoing) => {
    void sendNodeResponse(handler, incoming, outgoing);
  });
  server.on("upgrade", (request, socket, head) => {
    if (upgrade.canHandle(request)) {
      upgrade.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  });

  return {
    handler,
    server,
    close() {
      upgrade.close();
    },
  };
}

async function serveStatic(input: {
  request: Request;
  webRoot: string;
}): Promise<Response> {
  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const url = new URL(input.request.url);
  const filePath = await resolveStaticPath(input.webRoot, url.pathname);
  const body = input.request.method === "HEAD" ? null : await readFile(filePath);
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentTypeFor(filePath) },
  });
}

async function resolveStaticPath(webRoot: string, pathname: string): Promise<string> {
  const decodedPath = decodePathname(pathname);
  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
  const candidate = resolve(webRoot, `.${requested}`);
  if (isInsideRoot(webRoot, candidate) && await isFile(candidate)) {
    return candidate;
  }

  const indexPath = resolve(webRoot, "index.html");
  if (await isFile(indexPath)) return indexPath;
  throw new Error(`missing demo web entry: ${indexPath}`);
}

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return "/";
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isInsideRoot(webRoot: string, path: string): boolean {
  return path === webRoot || path.startsWith(`${webRoot}${sep}`);
}

function isDemoApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/dev/object-storage/");
}

function isCompleteUploadRequest(method: string, pathname: string): boolean {
  return (
    method === "POST" &&
    /^\/api\/recordings\/upload-sessions\/[^/]+\/complete$/u.test(pathname)
  );
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function sendNodeResponse(
  handler: CloudApiHandler,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    const request = await toWebRequest(incoming);
    const response = await handler(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "text/plain; charset=utf-8");
    outgoing.end(error instanceof Error ? error.message : "Internal Server Error");
  }
}

async function toWebRequest(incoming: IncomingMessage): Promise<Request> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
  const body = await readIncomingBody(incoming);
  return new Request(url, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body: body.byteLength > 0 ? new Uint8Array(body) : undefined,
  });
}

function readIncomingBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => resolve(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}
