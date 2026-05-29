export type InterviewIceCandidateEvent = {
  candidate: RTCIceCandidate | InterviewIceCandidateSignal;
};

export type InterviewIceCandidateSignal = RTCIceCandidateInit | null;

export type InterviewTrackEvent = {
  track: MediaStreamTrack;
  streams: MediaStream[];
};

export type InterviewDataChannelState = "not-created" | RTCDataChannelState;

export type InterviewDataChannelMessageEvent = {
  data: unknown;
};

export type InterviewEventsDataChannel = {
  readonly label: string;
  readonly readyState: RTCDataChannelState;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: InterviewDataChannelMessageEvent) => void) | null;
  send(data: string): void;
  close(): void;
};

export type InterviewDataChannelEvent = {
  channel: InterviewEventsDataChannel;
};

export type InterviewPeerConnection = {
  readonly localDescription: RTCSessionDescriptionInit | null;
  readonly remoteDescription: RTCSessionDescriptionInit | null;
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly signalingState: RTCSignalingState;
  onicecandidate: ((event: InterviewIceCandidateEvent) => void) | null;
  ontrack: ((event: InterviewTrackEvent) => void) | null;
  ondatachannel: ((event: InterviewDataChannelEvent) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onsignalingstatechange: (() => void) | null;
  addTrack(track: MediaStreamTrack, stream: MediaStream): void;
  createDataChannel(label: string, dataChannelDict?: RTCDataChannelInit): InterviewEventsDataChannel;
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
  eventsDataChannelState: InterviewDataChannelState;
};

export type InterviewMediaSession = {
  getState(): InterviewMediaSessionState;
  getEventsDataChannel(): InterviewEventsDataChannel | null;
  requestLocalMedia(constraints?: MediaStreamConstraints): Promise<InterviewMediaSessionState>;
  setMicrophoneEnabled(enabled: boolean): InterviewMediaSessionState;
  setCameraEnabled(enabled: boolean): InterviewMediaSessionState;
  ensureEventsDataChannel(): InterviewEventsDataChannel;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<InterviewMediaSessionState>;
  addRemoteIceCandidate(candidate: InterviewIceCandidateSignal): Promise<InterviewMediaSessionState>;
  drainOutgoingIceCandidates(): InterviewIceCandidateSignal[];
  subscribe(listener: (state: InterviewMediaSessionState) => void): () => void;
  close(): InterviewMediaSessionState;
};

const DEFAULT_MEDIA_CONSTRAINTS: MediaStreamConstraints = { audio: true, video: true };
const EVENTS_DATA_CHANNEL_LABEL = "events";
const EVENTS_DATA_CHANNEL_OPTIONS: RTCDataChannelInit = { ordered: true };

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
  let eventsDataChannel: InterviewEventsDataChannel | null = null;
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
    eventsDataChannelState: closed ? "closed" : eventsDataChannel?.readyState ?? "not-created",
  });

  const notify = (): InterviewMediaSessionState => {
    const next = snapshot();
    listeners.forEach((listener) => listener(cloneSessionState(next)));
    return next;
  };

  const attachEventsDataChannel = (channel: InterviewEventsDataChannel): InterviewEventsDataChannel => {
    eventsDataChannel = channel;
    eventsDataChannel.onopen = notify;
    eventsDataChannel.onclose = notify;
    notify();
    return eventsDataChannel;
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
  peer.ondatachannel = (event) => {
    if (closed || event.channel.label !== EVENTS_DATA_CHANNEL_LABEL || eventsDataChannel) {
      return;
    }
    attachEventsDataChannel(event.channel);
  };
  peer.onconnectionstatechange = notify;
  peer.oniceconnectionstatechange = notify;
  peer.onsignalingstatechange = notify;

  return {
    getState: snapshot,
    getEventsDataChannel() {
      return eventsDataChannel;
    },
    async requestLocalMedia(constraints = options.mediaConstraints ?? DEFAULT_MEDIA_CONSTRAINTS) {
      if (closed) {
        throw new Error("Interview media session is closed");
      }
      if (localStream) {
        throw new Error("Local media has already been requested for this interview session");
      }
      const requestedStream = await deps.getUserMedia(constraints);
      if (closed) {
        stopStreamTracks(requestedStream);
        throw new Error("Interview media session is closed");
      }
      localStream = requestedStream;
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
    ensureEventsDataChannel() {
      if (closed) {
        throw new Error("Interview media session is closed");
      }
      if (eventsDataChannel) {
        return eventsDataChannel;
      }
      return attachEventsDataChannel(
        peer.createDataChannel(EVENTS_DATA_CHANNEL_LABEL, EVENTS_DATA_CHANNEL_OPTIONS),
      );
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
      peer.ondatachannel = null;
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.onsignalingstatechange = null;
      stopStreamTracks(localStream);
      localStream = null;
      remoteStream = null;
      microphoneEnabled = false;
      cameraEnabled = false;
      outgoingIceCandidates = [];
      closeEventsDataChannel(eventsDataChannel);
      eventsDataChannel = null;
      peer.close();
      return notify();
    },
  };
}

function closeEventsDataChannel(channel: InterviewEventsDataChannel | null): void {
  if (!channel) {
    return;
  }
  channel.onopen = null;
  channel.onclose = null;
  channel.onmessage = null;
  if (channel.readyState !== "closed") {
    channel.close();
  }
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
