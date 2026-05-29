import type { CloudApiHandler } from "./cloudApiHandler.js";
import type { LocalDevObjectStorageHandler } from "./localDevObjectStorageHandler.js";

export function createApiHandler(deps: {
  cloud: CloudApiHandler;
  interview?: CloudApiHandler;
  objectStorage?: LocalDevObjectStorageHandler;
}): CloudApiHandler {
  const objectStorage = deps.objectStorage;

  return async (request: Request): Promise<Response> => {
    if (
      deps.interview &&
      new URL(request.url).pathname.startsWith("/api/interviews/")
    ) {
      return deps.interview(request);
    }
    if (objectStorage) {
      const objectResponse = await objectStorage(request);
      if (objectResponse) {
        return objectResponse;
      }
    }
    return deps.cloud(request);
  };
}
