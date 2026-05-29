import { describe, expect, it } from "vitest";
import {
  createInterviewMediaSession,
  type InterviewDataChannelEvent,
  type InterviewEventsDataChannel,
  type InterviewMediaSessionDependencies,
  type InterviewPeerConnection,
} from "../interviewMediaSession";

class FakeTrack {
  stopped = false;

  constructor(
    readonly kind: "audio" | "video",
    public enabled = true,
  ) {}

  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  private readonly tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }

  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }
}

class FakeDataChannel implements InterviewEventsDataChannel {
  readyState: RTCDataChannelState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closeCalls = 0;

  constructor(readonly label = "events") {}

  send(): void {}

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = "closed";
    this.onclose?.();
  }
}

class FakePeerConnection implements InterviewPeerConnection {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  onicecandidate: ((event: { candidate: RTCIceCandidate | RTCIceCandidateInit | null }) => void) | null =
    null;
  ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  ondatachannel: ((event: InterviewDataChannelEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  readonly addedTracks: Array<{ track: MediaStreamTrack; stream: MediaStream }> = [];
  readonly remoteCandidates: Array<RTCIceCandidateInit | null> = [];
  readonly createdDataChannels: Array<{
    label: string;
    options?: RTCDataChannelInit;
    channel: FakeDataChannel;
  }> = [];
  closed = false;

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.addedTracks.push({ track, stream });
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): InterviewEventsDataChannel {
    const channel = new FakeDataChannel(label);
    this.createdDataChannels.push({ label, options, channel });
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { ...description };
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = { ...description };
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    this.remoteCandidates.push(candidate ? { ...candidate } : null);
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  emitIceCandidate(candidate: RTCIceCandidateInit | null): void {
    this.onicecandidate?.({ candidate });
  }

  emitRemoteTrack(track: MediaStreamTrack, stream?: MediaStream): void {
    this.ontrack?.({ track, streams: stream ? [stream] : [] });
  }

  emitDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label);
    this.ondatachannel?.({ channel });
    return channel;
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function createFixture() {
  const audioTrack = new FakeTrack("audio");
  const videoTrack = new FakeTrack("video");
  const localStream = new FakeMediaStream([audioTrack, videoTrack]);
  const peer = new FakePeerConnection();
  const deps: InterviewMediaSessionDependencies = {
    createPeerConnection: () => peer,
    getUserMedia: async () => localStream as unknown as MediaStream,
    createMediaStream: () => new FakeMediaStream() as unknown as MediaStream,
  };

  return { audioTrack, videoTrack, localStream, peer, deps };
}

describe("InterviewMediaSession", () => {
  it("requests local media and adds audio/video tracks to the peer connection", async () => {
    const { localStream, peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });

    const state = await session.requestLocalMedia();

    expect(state.localStream).toBe(localStream);
    expect(state.microphoneEnabled).toBe(true);
    expect(state.cameraEnabled).toBe(true);
    expect(peer.addedTracks).toEqual([
      { track: localStream.getAudioTracks()[0], stream: localStream },
      { track: localStream.getVideoTracks()[0], stream: localStream },
    ]);
  });

  it("toggles microphone and camera by changing local track enabled flags", async () => {
    const { audioTrack, videoTrack, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });
    const updates: boolean[] = [];
    session.subscribe((state) => {
      updates.push(state.microphoneEnabled);
    });
    await session.requestLocalMedia();

    const muted = session.setMicrophoneEnabled(false);
    const hidden = session.setCameraEnabled(false);

    expect(audioTrack.enabled).toBe(false);
    expect(videoTrack.enabled).toBe(false);
    expect(muted.microphoneEnabled).toBe(false);
    expect(hidden.cameraEnabled).toBe(false);
    expect(updates).toContain(false);
  });

  it("exposes remote media when the peer connection receives remote tracks", () => {
    const { peer, deps } = createFixture();
    const remoteTrack = new FakeTrack("video") as unknown as MediaStreamTrack;
    const remoteStream = new FakeMediaStream([remoteTrack as unknown as FakeTrack]);
    const session = createInterviewMediaSession({ deps });

    peer.emitRemoteTrack(remoteTrack, remoteStream as unknown as MediaStream);

    expect(session.getState().remoteStream).toBe(remoteStream);
  });

  it("creates offer and answer descriptions and applies remote signaling inputs", async () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });

    const offer = await session.createOffer();
    await session.setRemoteDescription({ type: "answer", sdp: "answer-from-peer" });
    const answer = await session.createAnswer();
    await session.addRemoteIceCandidate({
      candidate: "candidate:1",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });

    expect(offer).toEqual({ type: "offer", sdp: "offer-sdp" });
    expect(answer).toEqual({ type: "answer", sdp: "answer-sdp" });
    expect(peer.localDescription).toEqual({ type: "answer", sdp: "answer-sdp" });
    expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "answer-from-peer" });
    expect(peer.remoteCandidates).toEqual([
      { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
    ]);
  });

  it("creates a reliable ordered events data channel once and exposes its lifecycle state", () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });

    expect(session.getState().eventsDataChannelState).toBe("not-created");

    const channel = session.ensureEventsDataChannel();
    const reused = session.ensureEventsDataChannel();

    expect(reused).toBe(channel);
    expect(peer.createdDataChannels).toHaveLength(1);
    expect(peer.createdDataChannels[0]).toMatchObject({
      label: "events",
      options: { ordered: true },
    });
    expect(session.getState().eventsDataChannelState).toBe("connecting");

    peer.createdDataChannels[0].channel.open();

    expect(session.getState().eventsDataChannelState).toBe("open");
  });

  it("receives a remote events data channel and exposes its lifecycle state", () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });
    const observedStates: Array<ReturnType<typeof session.getState>["eventsDataChannelState"]> = [];
    session.subscribe((state) => {
      observedStates.push(state.eventsDataChannelState);
    });

    const channel = peer.emitDataChannel("events");

    expect(session.getState().eventsDataChannelState).toBe("connecting");
    expect(session.getEventsDataChannel()).toBe(channel);

    channel.open();
    channel.close();

    expect(session.getState().eventsDataChannelState).toBe("closed");
    expect(observedStates).toEqual(["connecting", "open", "closed"]);
  });

  it("ignores remote data channels that are not the events channel", () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });

    const channel = peer.emitDataChannel("presence");
    channel.open();

    expect(session.getState().eventsDataChannelState).toBe("not-created");
  });

  it("queues local ICE candidates for the signaling layer and clears them after drain", () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });

    peer.emitIceCandidate({ candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
    peer.emitIceCandidate({ candidate: "candidate:2", sdpMid: "0", sdpMLineIndex: 1 });

    expect(session.getState().outgoingIceCandidates).toEqual([
      { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
      { candidate: "candidate:2", sdpMid: "0", sdpMLineIndex: 1 },
    ]);
    expect(session.drainOutgoingIceCandidates()).toEqual([
      { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
      { candidate: "candidate:2", sdpMid: "0", sdpMLineIndex: 1 },
    ]);
    expect(session.getState().outgoingIceCandidates).toEqual([]);
  });

  it("forwards and accepts null ICE candidates as end-of-candidates signals", async () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });

    peer.emitIceCandidate(null);
    await session.addRemoteIceCandidate(null);

    expect(session.drainOutgoingIceCandidates()).toEqual([null]);
    expect(peer.remoteCandidates).toEqual([null]);
  });

  it("stops local media tracks and publishes disabled state when closed", async () => {
    const { audioTrack, videoTrack, peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });
    const observedStates: Array<
      Pick<ReturnType<typeof session.getState>, "microphoneEnabled" | "cameraEnabled">
    > = [];
    session.subscribe((state) => {
      observedStates.push({
        microphoneEnabled: state.microphoneEnabled,
        cameraEnabled: state.cameraEnabled,
      });
    });
    await session.requestLocalMedia();

    const closed = session.close();

    expect(audioTrack.stopped).toBe(true);
    expect(videoTrack.stopped).toBe(true);
    expect(peer.closed).toBe(true);
    expect(closed.localStream).toBeNull();
    expect(closed.remoteStream).toBeNull();
    expect(closed.microphoneEnabled).toBe(false);
    expect(closed.cameraEnabled).toBe(false);
    expect(observedStates.at(-1)).toEqual({
      microphoneEnabled: false,
      cameraEnabled: false,
    });
  });

  it("closes the events data channel when closed", () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });
    session.ensureEventsDataChannel();
    peer.createdDataChannels[0].channel.onmessage = () => {};

    const closed = session.close();

    expect(peer.createdDataChannels[0].channel.closeCalls).toBe(1);
    expect(peer.createdDataChannels[0].channel.onmessage).toBeNull();
    expect(closed.eventsDataChannelState).toBe("closed");
    expect(session.getState().eventsDataChannelState).toBe("closed");
  });

  it("closes a received remote events data channel when closed", () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });
    const channel = peer.emitDataChannel("events");
    channel.onmessage = () => {};

    const closed = session.close();

    expect(channel.closeCalls).toBe(1);
    expect(channel.onmessage).toBeNull();
    expect(closed.eventsDataChannelState).toBe("closed");
    expect(session.getState().eventsDataChannelState).toBe("closed");
  });

  it("stops local media if the session closes while getUserMedia is pending", async () => {
    const { audioTrack, videoTrack, localStream, peer, deps } = createFixture();
    let resolveMedia!: (stream: MediaStream) => void;
    deps.getUserMedia = () =>
      new Promise<MediaStream>((resolve) => {
        resolveMedia = resolve;
      });
    const session = createInterviewMediaSession({ deps });

    const request = session.requestLocalMedia();
    session.close();
    resolveMedia(localStream as unknown as MediaStream);

    await expect(request).rejects.toThrow("Interview media session is closed");
    expect(audioTrack.stopped).toBe(true);
    expect(videoTrack.stopped).toBe(true);
    expect(peer.addedTracks).toEqual([]);
    expect(session.getState().localStream).toBeNull();
  });

  it("ignores late peer events after close and clears pending ICE candidates", async () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });
    await session.requestLocalMedia();
    peer.emitIceCandidate({ candidate: "candidate:before-close", sdpMid: "0", sdpMLineIndex: 0 });

    session.close();
    let lateNotifications = 0;
    session.subscribe(() => {
      lateNotifications += 1;
    });
    peer.emitIceCandidate({ candidate: "candidate:after-close", sdpMid: "0", sdpMLineIndex: 1 });
    peer.emitRemoteTrack(new FakeTrack("video") as unknown as MediaStreamTrack);
    peer.setConnectionState("connected");

    expect(lateNotifications).toBe(0);
    expect(session.getState().remoteStream).toBeNull();
    expect(session.getState().connectionState).toBe("closed");
    expect(session.getState().outgoingIceCandidates).toEqual([]);
  });

  it("rejects repeated local media requests to avoid duplicate peer tracks", async () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });
    await session.requestLocalMedia();

    await expect(session.requestLocalMedia()).rejects.toThrow(
      "Local media has already been requested for this interview session",
    );

    expect(peer.addedTracks).toHaveLength(2);
  });

  it("notifies subscribers when peer connection state changes and exposes isolated ICE snapshots", () => {
    const { peer, deps } = createFixture();
    const session = createInterviewMediaSession({ deps });
    let observedConnectionState: RTCPeerConnectionState = "new";
    session.subscribe((state) => {
      observedConnectionState = state.connectionState;
      state.outgoingIceCandidates.push({ candidate: "mutated" });
    });

    peer.emitIceCandidate({ candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
    peer.setConnectionState("connected");

    expect(observedConnectionState).toBe("connected");
    expect(session.getState().outgoingIceCandidates).toEqual([
      { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
    ]);
  });
});
