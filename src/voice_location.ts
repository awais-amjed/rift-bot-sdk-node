import { BotError, type BotSession } from './session.ts';

/**
 * Where this bot is in voice, said the way a member's app says it.
 *
 * A member's sidebar draws who is in which voice channel from two things: a
 * roster read from LiveKit when the app connects, and a broadcast on
 * `voice:<server id>` each time somebody moves. A bot used to say nothing, so
 * it was drawn from the roster read alone. A member whose app connected before
 * the bot arrived did not see it come in, and one whose app read the roster
 * while the bot was there saw it stay after it left — online, so still
 * believed — until that member restarted the app. So a bot says where it is
 * on joining and on leaving, like everybody else.
 *
 * The message is the app's own (`VoiceLocations` in `rift-app`): `here`, with
 * `{v: 1, userId, channelId}`, a null channel meaning "in none".
 */
export const VOICE_LOCATION_EVENT = 'here';
export const VOICE_LOCATION_VERSION = 1;

export function voiceLocationTopic(serverId: string): string {
  return `voice:${serverId}`;
}

export function voiceLocation(
  userId: string,
  channelId: string | null,
): { v: number; userId: string; channelId: string | null } {
  return { v: VOICE_LOCATION_VERSION, userId, channelId };
}

/**
 * The voice channels one session is connected to, oldest first.
 *
 * A member's app holds one channel per person, so a bot in two calls at once
 * can only be drawn in one of them. It is the newest: leaving that one moves
 * it to the one before, and only leaving the last says "in none".
 */
export class VoicePlaces {
  #channels: string[] = [];

  /** Joined [channelId]: where to say this bot is now. */
  enter(channelId: string): string {
    this.#channels.push(channelId);
    return channelId;
  }

  /** Left [channelId]: where to say this bot is now, or null for nowhere. */
  leave(channelId: string): string | null {
    const at = this.#channels.lastIndexOf(channelId);
    if (at >= 0) this.#channels.splice(at, 1);
    return this.#channels.at(-1) ?? null;
  }
}

const places = new WeakMap<BotSession, { places: VoicePlaces; said: Promise<void> }>();

/**
 * Move this bot's place with [move] and tell the server's members.
 *
 * One message at a time per session, in order: a join and a quick leave sent
 * side by side could arrive the wrong way round and leave the bot drawn in a
 * call it had already left.
 *
 * Never throws. Losing this message is what every bot did before it existed,
 * and a member's next roster read puts it right; failing a join or a leave
 * over it would be worse.
 */
export function announcePlace(
  session: BotSession,
  move: (places: VoicePlaces) => string | null,
): Promise<void> {
  let entry = places.get(session);
  if (!entry) {
    entry = { places: new VoicePlaces(), said: Promise.resolve() };
    places.set(session, entry);
  }
  const channelId = move(entry.places);
  entry.said = entry.said.then(() => say(session, channelId));
  return entry.said;
}

async function say(session: BotSession, channelId: string | null): Promise<void> {
  const userId = session.userId;
  if (userId === null) return;
  const send = () =>
    session.broadcast(
      voiceLocationTopic(session.serverId),
      VOICE_LOCATION_EVENT,
      voiceLocation(userId, channelId),
    );
  try {
    await send();
  } catch (error) {
    // An hour into a song the session has run out. Once more, signed in again.
    if (!(error instanceof BotError) || error.status !== 401) return;
    try {
      await session.login();
      await send();
    } catch {
      // See above: the roster read is the fallback.
    }
  }
}
