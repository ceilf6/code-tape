export type InterviewIceCandidateEvent = {
  candidate: RTCIceCandidate | InterviewIceCandidateSignal;
};

export type InterviewIceCandidateSignal = RTCIceCandidateInit | null;

export type InterviewTrackEvent = {
  track: MediaStreamTrack;
  streams: MediaStream[];
};

export type InterviewPeerConnection = {
  readonly localDescription: RTCSessionDescriptionInit | null;
  readonly remoteDescription: RTCSessionDescriptionInit | null;
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly signalingState: RTCSignalingState;
  onicecandidate: ((event: InterviewIceCandidateEvent) => void) | null;
  ontrack: ((event: InterviewTrackEvent) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onsignalingstatechange: (() => void) | null;
  addTrack(track: MediaStreamTrack, stream: MediaStream): void;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: InterviewIceCandidateSignal): Promise<void>;
  close(): void;
};

export type InterviewMediaSessionDependencies = {
  createPeerConnection?: (configuration?: RTCConfiguration) => InterviewPeerConnection;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createMediaStream?: () => MediaStream;
};

export type InterviewMediaSessionOptions = {
  peerConnectionConfig?: RTCConfiguration;
  mediaConstraints?: MediaStreamConstraints;
  deps?: InterviewMediaSessionDependencies;
};

export type InterviewMediaSessionState = {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  outgoingIceCandidates: InterviewIceCandidateSignal[];
};

export type InterviewMediaSession = {
  getState(): InterviewMediaSessionState;
  requestLocalMedia(constraints?: MediaStreamConstraints): Promise<InterviewMediaSessionState>;
  setMicrophoneEnabled(enabled: boolean): InterviewMediaSessionState;
  setCameraEnabled(enabled: boolean): InterviewMediaSessionState;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<InterviewMediaSessionState>;
  addRemoteIceCandidate(candidate: InterviewIceCandidateSignal): Promise<InterviewMediaSessionState>;
  drainOutgoingIceCandidates(): InterviewIceCandidateSignal[];
  subscribe(listener: (state: InterviewMediaSessionState) => void): () => void;
  close(): InterviewMediaSessionState;
};

const DEFAULT_MEDIA_CONSTRAINTS: MediaStreamConstraints = { audio: true, video: true };

export function createInterviewMediaSession(
  options: InterviewMediaSessionOptions = {},
): InterviewMediaSession {
  const deps = resolveDependencies(options.deps);
  const peer = deps.createPeerConnection(options.peerConnectionConfig);
  const listeners = new Set<(state: InterviewMediaSessionState) => void>();
  let localStream: MediaStream | null = null;
  let remoteStream: MediaStream | null = null;
  let microphoneEnabled = false;
  let cameraEnabled = false;
  let outgoingIceCandidates: InterviewIceCandidateSignal[] = [];
  let closed = false;

  const snapshot = (): InterviewMediaSessionState => ({
    localStream,
    remoteStream,
    microphoneEnabled,
    cameraEnabled,
    connectionState: closed ? "closed" : peer.connectionState,
    iceConnectionState: closed ? "closed" : peer.iceConnectionState,
    signalingState: closed ? "closed" : peer.signalingState,
    outgoingIceCandidates: cloneIceCandidates(outgoingIceCandidates),
  });

  const notify = (): InterviewMediaSessionState => {
    const next = snapshot();
    listeners.forEach((listener) => listener(cloneSessionState(next)));
    return next;
  };

  peer.onicecandidate = (event) => {
    if (closed) {
      return;
    }
    outgoingIceCandidates = [...outgoingIceCandidates, cloneIceCandidateSignal(event.candidate)];
    notify();
  };
  peer.ontrack = (event) => {
    if (closed) {
      return;
    }
    remoteStream = event.streams[0] ?? remoteStream ?? deps.createMediaStream();
    if (event.streams.length === 0) {
      remoteStream.addTrack(event.track);
    }
    notify();
  };
  peer.onconnectionstatechange = notify;
  peer.oniceconnectionstatechange = notify;
  peer.onsignalingstatechange = notify;

  return {
    getState: snapshot,
    async requestLocalMedia(constraints = options.mediaConstraints ?? DEFAULT_MEDIA_CONSTRAINTS) {
      if (closed) {
        throw new Error("Interview media session is closed");
      }
      if (localStream) {
        throw new Error("Local media has already been requested for this interview session");
      }
      localStream = await deps.getUserMedia(constraints);
      localStream.getTracks().forEach((track) => {
        peer.addTrack(track, localStream as MediaStream);
      });
      microphoneEnabled = hasEnabledTrack(localStream, "audio");
      cameraEnabled = hasEnabledTrack(localStream, "video");
      return notify();
    },
    setMicrophoneEnabled(enabled) {
      setTracksEnabled(localStream, "audio", enabled);
      microphoneEnabled = hasEnabledTrack(localStream, "audio");
      return notify();
    },
    setCameraEnabled(enabled) {
      setTracksEnabled(localStream, "video", enabled);
      cameraEnabled = hasEnabledTrack(localStream, "video");
      return notify();
    },
    async createOffer(offerOptions) {
      const offer = await peer.createOffer(offerOptions);
      await peer.setLocalDescription(offer);
      notify();
      return cloneSessionDescription(offer);
    },
    async createAnswer(answerOptions) {
      const answer = await peer.createAnswer(answerOptions);
      await peer.setLocalDescription(answer);
      notify();
      return cloneSessionDescription(answer);
    },
    async setRemoteDescription(description) {
      await peer.setRemoteDescription(description);
      return notify();
    },
    async addRemoteIceCandidate(candidate) {
      await peer.addIceCandidate(candidate);
      return notify();
    },
    drainOutgoingIceCandidates() {
      const drained = cloneIceCandidates(outgoingIceCandidates);
      outgoingIceCandidates = [];
      notify();
      return drained;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) {
        return snapshot();
      }
      closed = true;
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.onsignalingstatechange = null;
      stopStreamTracks(localStream);
      localStream = null;
      remoteStream = null;
      microphoneEnabled = false;
      cameraEnabled = false;
      outgoingIceCandidates = [];
      peer.close();
      return notify();
    },
  };
}

function resolveDependencies(deps: InterviewMediaSessionDependencies = {}): Required<InterviewMediaSessionDependencies> {
  return {
    createPeerConnection: deps.createPeerConnection ?? defaultCreatePeerConnection,
    getUserMedia: deps.getUserMedia ?? defaultGetUserMedia,
    createMediaStream: deps.createMediaStream ?? defaultCreateMediaStream,
  };
}

function defaultCreatePeerConnection(configuration?: RTCConfiguration): InterviewPeerConnection {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("RTCPeerConnection is not available in this environment");
  }
  return new RTCPeerConnection(configuration) as unknown as InterviewPeerConnection;
}

async function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia is not available in this environment");
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

function defaultCreateMediaStream(): MediaStream {
  if (typeof MediaStream === "undefined") {
    throw new Error("MediaStream is not available in this environment");
  }
  return new MediaStream();
}

function setTracksEnabled(
  stream: MediaStream | null,
  kind: "audio" | "video",
  enabled: boolean,
): void {
  tracksOfKind(stream, kind).forEach((track) => {
    track.enabled = enabled;
  });
}

function hasEnabledTrack(stream: MediaStream | null, kind: "audio" | "video"): boolean {
  return tracksOfKind(stream, kind).some((track) => track.enabled);
}

function tracksOfKind(stream: MediaStream | null, kind: "audio" | "video"): MediaStreamTrack[] {
  if (!stream) {
    return [];
  }
  return kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
}

function cloneSessionState(state: InterviewMediaSessionState): InterviewMediaSessionState {
  return {
    ...state,
    outgoingIceCandidates: cloneIceCandidates(state.outgoingIceCandidates),
  };
}

function stopStreamTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
}

function cloneIceCandidates(candidates: InterviewIceCandidateSignal[]): InterviewIceCandidateSignal[] {
  return candidates.map(cloneIceCandidateSignal);
}

function cloneIceCandidateSignal(
  candidate: RTCIceCandidate | InterviewIceCandidateSignal,
): InterviewIceCandidateSignal {
  if (candidate === null) {
    return null;
  }
  return cloneIceCandidate(candidate);
}

function cloneIceCandidate(candidate: RTCIceCandidate | RTCIceCandidateInit): RTCIceCandidateInit {
  if ("toJSON" in candidate && typeof candidate.toJSON === "function") {
    return candidate.toJSON();
  }

  const cloned: RTCIceCandidateInit = {
    candidate: candidate.candidate,
  };
  if (candidate.sdpMid !== undefined) {
    cloned.sdpMid = candidate.sdpMid;
  }
  if (candidate.sdpMLineIndex !== undefined) {
    cloned.sdpMLineIndex = candidate.sdpMLineIndex;
  }
  if (candidate.usernameFragment !== undefined) {
    cloned.usernameFragment = candidate.usernameFragment;
  }
  return cloned;
}

function cloneSessionDescription(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  return { ...description };
}
