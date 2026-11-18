import { Room, Booking, AvailabilityResult, DAY_MINUTES } from '@/types';
import { checkAvailability } from '@/utils/availability';
import { labelToMinutes, minutesToLabel } from '@/utils/time';

export const EXPLAIN_TIMEOUT_MS = 500;
export const MAX_EXPLANATION_LENGTH = 300;
export const MAX_TIME_TEXT_LENGTH = 5;

export type ExplainReasonCode =
  | 'OK'
  | 'AC1'
  | 'AC2'
  | 'AC3'
  | 'AC4'
  | 'VALIDATION'
  | 'TIMEOUT'
  | 'ERROR';

export interface ExplainStructuredResult {
  available: boolean;
  reasonCode: ExplainReasonCode;
  reason: string;
  startLabel: string;
  endLabel: string;
  currentTimeLabel: string;
  roomName: string;
  durationMinutes: number;
  bookedBy: string | null;
  fallbackUsed: boolean;
}

export interface ExplainInput {
  roomName: string;
  startText: string;
  endText: string;
  currentTime: number;
}

export interface ExplainOutcome {
  text: string;
  fallbackUsed: boolean;
  reasonCode: ExplainReasonCode;
}

const FALLBACK_TEXT: Record<ExplainReasonCode, string> = {
  OK: 'The room is available for the requested interval.',
  AC1: 'The requested interval failed the booking validation rules.',
  AC2: 'The requested booking exceeds the maximum allowed duration.',
  AC3: 'The room is currently blocked and cannot be booked.',
  AC4: 'The requested interval overlaps an existing booking.',
  VALIDATION: 'The explanation input was invalid.',
  TIMEOUT: 'The explanation could not be generated in time.',
  ERROR: 'The explanation could not be generated.',
};

export function validateExplainInput(
  input: ExplainInput,
): { valid: boolean; error?: string; start?: number; end?: number } {
  const { startText, endText } = input;

  if (!startText || !endText || startText.trim() === '' || endText.trim() === '') {
    return { valid: false, error: 'Start and end times are required.' };
  }

  if (startText.length > MAX_TIME_TEXT_LENGTH || endText.length > MAX_TIME_TEXT_LENGTH) {
    return { valid: false, error: 'Time text must be at most 5 characters.' };
  }

  const start = labelToMinutes(startText);
  const end = labelToMinutes(endText);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { valid: false, error: 'Times must be in HH:MM format.' };
  }

  if (start < 0 || end > DAY_MINUTES) {
    return { valid: false, error: 'Times must be within 00:00-24:00.' };
  }

  if (start >= end) {
    return { valid: false, error: 'Start time must be before end time.' };
  }

  return { valid: true, start, end };
}

export function buildStructuredResult(
  result: AvailabilityResult,
  input: ExplainInput,
  start: number,
  end: number,
): ExplainStructuredResult {
  const reasonCode = (result.ruleCode ?? (result.available ? 'OK' : 'VALIDATION')) as ExplainReasonCode;
  const known: ExplainReasonCode[] = ['OK', 'AC1', 'AC2', 'AC3', 'AC4'];
  const safeReasonCode = known.includes(reasonCode) ? reasonCode : 'VALIDATION';

  const bookedByMatch = result.reason.match(/\(([^)]+)\)/);
  const bookedBy = bookedByMatch ? bookedByMatch[1] : null;

  return {
    available: result.available,
    reasonCode: safeReasonCode,
    reason: result.reason,
    startLabel: input.startText,
    endLabel: input.endText,
    currentTimeLabel: minutesToLabel(input.currentTime),
    roomName: input.roomName,
    durationMinutes: end - start,
    bookedBy,
    fallbackUsed: false,
  };
}

export function explainWithMock(sr: ExplainStructuredResult): string {
  const {
    available,
    reasonCode,
    startLabel,
    endLabel,
    currentTimeLabel,
    roomName,
    durationMinutes,
    bookedBy,
  } = sr;

  if (available) {
    return `${roomName} is free from ${startLabel} to ${endLabel}. The ${durationMinutes}-minute slot is within the allowed limit.`;
  }

  switch (reasonCode) {
    case 'AC1': {
      const start = labelToMinutes(startLabel);
      const end = labelToMinutes(endLabel);
      const current = (currentTimeLabel.match(/\d{1,2}:\d{2}/)?.[0] ?? '') as string;
      const currentMin = current ? labelToMinutes(current) : NaN;
      if (start <= currentMin || end <= currentMin) {
        return `The start time ${startLabel} has already passed. The current time is ${currentTimeLabel}.`;
      }
      return `The start time must be before the end time for the interval ${startLabel} to ${endLabel}.`;
    }
    case 'AC2':
      return `The ${durationMinutes}-minute request exceeds the 120-minute maximum. Choose a shorter interval for ${roomName}.`;
    case 'AC3':
      return `${roomName} is blocked and cannot be booked. Choose a different room.`;
    case 'AC4':
      return `The slot ${startLabel} to ${endLabel} overlaps an existing booking${bookedBy ? ` by ${bookedBy}` : ''}. Pick a non-overlapping interval.`;
    default:
      return FALLBACK_TEXT[reasonCode];
  }
}

export function validateExplanation(
  text: string,
  input: ExplainInput,
  reasonCode: ExplainReasonCode,
): { valid: boolean; text: string } {
  if (text.length > MAX_EXPLANATION_LENGTH) {
    return { valid: false, text: FALLBACK_TEXT[reasonCode] };
  }

  const timePattern = /\b\d{1,2}:\d{2}\b/g;
  const mentionedTimes = text.match(timePattern) ?? [];
  const allowedTimes = new Set([input.startText, input.endText, minutesToLabel(input.currentTime)]);

  for (const t of mentionedTimes) {
    if (!allowedTimes.has(t)) {
      return { valid: false, text: FALLBACK_TEXT[reasonCode] };
    }
  }

  return { valid: true, text };
}

export function withTimeout(
  fn: () => string | Promise<string>,
  timeoutMs: number = EXPLAIN_TIMEOUT_MS,
): Promise<string> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<string>((resolve) => {
    timerId = setTimeout(() => resolve(FALLBACK_TEXT['TIMEOUT']), timeoutMs);
  });
  const work = Promise.resolve()
    .then(() => fn())
    .catch(() => FALLBACK_TEXT['ERROR'])
    .finally(() => {
      if (timerId !== undefined) clearTimeout(timerId);
    });
  return Promise.race([work, timer]);
}

export async function explainAvailability(
  room: Room | null,
  existingBookings: Booking[],
  input: ExplainInput,
): Promise<ExplainOutcome> {
  const validation = validateExplainInput(input);
  if (!validation.valid || validation.start === undefined || validation.end === undefined) {
    const text = FALLBACK_TEXT['VALIDATION'];
    return { text, fallbackUsed: true, reasonCode: 'VALIDATION' };
  }

  const result = checkAvailability(room, validation.start, validation.end, input.currentTime, existingBookings);
  const sr = buildStructuredResult(result, input, validation.start, validation.end);

  let text = explainWithMock(sr);
  const validated = validateExplanation(text, input, sr.reasonCode);
  if (!validated.valid) {
    text = validated.text;
    return { text, fallbackUsed: true, reasonCode: sr.reasonCode };
  }

  try {
    const timed = await withTimeout(() => text, EXPLAIN_TIMEOUT_MS);
    const fallbackUsed = timed !== text;
    return { text: timed, fallbackUsed, reasonCode: sr.reasonCode };
  } catch {
    return { text: FALLBACK_TEXT['ERROR'], fallbackUsed: true, reasonCode: 'ERROR' };
  }
}
