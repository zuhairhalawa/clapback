// Turning an echo time into plain advice.
//
// Thresholds are rules of thumb for small rooms, not a standard for every space:
//  - lectures / teaching: ANSI/ASA S12.60 asks for at most 0.6 s in classrooms under 283 m³;
//  - calls: speech stays clear to most listeners up to about 0.5 s;
//  - voice recording: home vocal booths and podcast corners aim for about 0.3 s.

export type Grade = 'good' | 'okay' | 'poor';

export interface UseCase {
  id: 'calls' | 'lectures' | 'recording';
  name: string;
  good: number;
  okay: number;
  /** What each grade means for this use. */
  says: Record<Grade, string>;
}

export const USES: UseCase[] = [
  {
    id: 'calls',
    name: 'Video calls',
    good: 0.5,
    okay: 0.8,
    says: {
      good: 'You will sound clear.',
      okay: 'Fine, with a little room sound.',
      poor: 'People may ask you to repeat yourself.',
    },
  },
  {
    id: 'lectures',
    name: 'Teaching in the room',
    good: 0.6,
    okay: 0.9,
    says: {
      good: 'Meets the classroom guideline (0.6 s).',
      okay: 'Back rows will strain a little.',
      poor: 'Words blur together for listeners.',
    },
  },
  {
    id: 'recording',
    name: 'Recording your voice',
    good: 0.3,
    okay: 0.5,
    says: {
      good: 'Dry enough for podcasts and voice-overs.',
      okay: 'Listeners will hear the room.',
      poor: 'Your recording will sound like a bathroom.',
    },
  },
];

export function grade(rt60: number, use: UseCase): Grade {
  if (rt60 <= use.good) return 'good';
  if (rt60 <= use.okay) return 'okay';
  return 'poor';
}

export const GRADE_WORD: Record<Grade, string> = { good: 'Good', okay: 'Okay', poor: 'Too echoey' };

export interface Character {
  word: string;
  line: string;
}

/** One word for the room, and a sentence about what it does to a voice. */
export function character(rt60: number): Character {
  if (rt60 <= 0.3) return { word: 'Dry', line: 'Sound dies away almost at once, like in a car or a closet full of clothes.' };
  if (rt60 <= 0.5) return { word: 'Calm', line: 'A little room sound, the way a furnished bedroom or office usually sounds.' };
  if (rt60 <= 0.8) return { word: 'Lively', line: 'Your voice hangs in the air for a moment after each word.' };
  if (rt60 <= 1.2) return { word: 'Echoey', line: 'Each word is still ringing when the next one starts.' };
  return { word: 'Cavernous', line: 'Like a stairwell or an empty hall: speech turns to mush.' };
}

export interface RoomSize {
  id: string;
  name: string;
  /** Volume in m³. */
  volume: number;
  dims: string;
}

export const ROOM_SIZES: RoomSize[] = [
  { id: 'small', name: 'Small bedroom', volume: 22, dims: 'about 3 × 3 m' },
  { id: 'bedroom', name: 'Bedroom or study', volume: 36, dims: 'about 4 × 3.5 m' },
  { id: 'living', name: 'Living room', volume: 61, dims: 'about 5 × 4.5 m' },
  { id: 'classroom', name: 'Classroom', volume: 168, dims: 'about 8 × 7 m' },
];

export interface Fix {
  text: string;
  /** Equivalent absorption area added, m² (Sabine), or 0 for tips that move you rather than the room. */
  area: number;
  thick?: boolean;
}

// Rough mid-frequency absorption of household items (area × absorption coefficient).
const ITEMS: Fix[] = [
  { text: 'Hang a thick duvet or blanket on the wall behind your screen', area: 1.8, thick: true },
  { text: 'Put a large rug on the bare floor', area: 1.5 },
  { text: 'Close heavy curtains over the window', area: 1.1 },
  { text: 'Open a wardrobe full of clothes facing you', area: 0.9, thick: true },
  { text: 'Pile pillows and cushions on the bed or sofa', area: 0.6, thick: true },
  { text: 'Lean a folded mattress topper or a sofa cushion against the bare wall', area: 0.8, thick: true },
];

export interface Advice {
  /** The echo time worth aiming for. */
  target: number;
  /** Extra absorption needed, m² (0 when already there). */
  needed: number;
  fixes: Fix[];
  /** Advice that depends on which frequencies ring longest. */
  bandNote?: string;
  tips: string[];
}

/**
 * Sabine: RT60 = 0.161 · V / A. To go from `now` to `target` you need
 * ΔA = 0.161 · V · (1/target − 1/now) more square metres of absorption.
 */
export function absorptionNeeded(now: number, target: number, volume: number): number {
  if (now <= target) return 0;
  return 0.161 * volume * (1 / target - 1 / now);
}

export function advise(
  rt60: number,
  use: UseCase,
  room: RoomSize,
  bands: { fc: number; rt60: number | null }[],
): Advice {
  const target = use.good;
  const needed = absorptionNeeded(rt60, target, room.volume);

  const at = (fc: number) => bands.find((b) => b.fc === fc)?.rt60 ?? null;
  const low = at(500);
  const high = at(2000) ?? at(4000);
  let bandNote: string | undefined;
  let preferThick = false;
  if (low !== null && high !== null && low > high * 1.3) {
    bandNote = 'Low sounds ring longest here. Thin cloth only soaks up the highs, so thick, soft things work better: duvets, cushions, a full wardrobe.';
    preferThick = true;
  } else if (low !== null && high !== null && high > low * 1.2) {
    bandNote = 'High sounds ring longest here, which usually means bare hard surfaces. Curtains and a rug will help quickly.';
  }

  const fixes: Fix[] = [];
  if (needed > 0) {
    const pool = ITEMS.slice().sort((a, b) => (preferThick ? Number(!!b.thick) - Number(!!a.thick) : 0) || b.area - a.area);
    let sum = 0;
    for (const item of pool) {
      if (sum >= needed) break;
      fixes.push(item);
      sum += item.area;
    }
  }

  const tips = [
    'Keep the microphone close, about a hand-span from your mouth. Every time you halve the distance, your voice gets 6 dB stronger compared with the echo.',
    'Face into the room, not towards a bare wall or window.',
  ];
  return { target, needed, fixes, bandNote, tips };
}

/** Median of a list (for several claps of one take). */
export function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
