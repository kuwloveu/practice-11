import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  validateExplainInput,
  buildStructuredResult,
  explainWithMock,
  validateExplanation,
  withTimeout,
  explainAvailability,
  ExplainStructuredResult,
  ExplainInput,
  EXPLAIN_TIMEOUT_MS,
  MAX_EXPLANATION_LENGTH,
} from '@/utils/explain';
import { Room, Booking } from '@/types';

function makeRoom(): Room {
  return { id: 'r1', name: 'Test Room', building: 'Block A', capacity: 10, blocked: false };
}

function makeBookings(): Booking[] {
  return [{ id: 'b1', roomId: 'r1', start: 600, end: 660, bookedBy: 'Alice' }];
}

function baseInput(overrides: Partial<ExplainInput> = {}): ExplainInput {
  return {
    roomName: 'Test Room',
    startText: '11:00',
    endText: '12:00',
    currentTime: 540,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('validateExplainInput', () => {
  it('rejects empty start text', () => {
    const r = validateExplainInput(baseInput({ startText: '' }));
    expect(r.valid).toBe(false);
  });

  it('rejects empty end text', () => {
    const r = validateExplainInput(baseInput({ endText: '' }));
    expect(r.valid).toBe(false);
  });

  it('rejects whitespace-only start text', () => {
    const r = validateExplainInput(baseInput({ startText: '   ' }));
    expect(r.valid).toBe(false);
  });

  it('rejects malformed start time', () => {
    const r = validateExplainInput(baseInput({ startText: '14' }));
    expect(r.valid).toBe(false);
  });

  it('rejects malformed end time', () => {
    const r = validateExplainInput(baseInput({ endText: 'abc' }));
    expect(r.valid).toBe(false);
  });

  it('rejects start text longer than 5 characters', () => {
    const r = validateExplainInput(baseInput({ startText: '111:00' }));
    expect(r.valid).toBe(false);
  });

  it('rejects end text longer than 5 characters', () => {
    const r = validateExplainInput(baseInput({ endText: '12:000' }));
    expect(r.valid).toBe(false);
  });

  it('rejects start >= end (equal)', () => {
    const r = validateExplainInput(baseInput({ startText: '12:00', endText: '12:00' }));
    expect(r.valid).toBe(false);
  });

  it('rejects start > end', () => {
    const r = validateExplainInput(baseInput({ startText: '13:00', endText: '12:00' }));
    expect(r.valid).toBe(false);
  });

  it('accepts valid input and returns parsed minutes', () => {
    const r = validateExplainInput(baseInput());
    expect(r.valid).toBe(true);
    expect(r.start).toBe(660);
    expect(r.end).toBe(720);
  });

  it('accepts end exactly 24:00', () => {
    const r = validateExplainInput(baseInput({ startText: '23:00', endText: '24:00' }));
    expect(r.valid).toBe(true);
  });

  it('rejects end beyond 24:00', () => {
    const r = validateExplainInput(baseInput({ startText: '23:30', endText: '24:01' }));
    expect(r.valid).toBe(false);
  });
});

describe('buildStructuredResult', () => {
  it('maps an available result to reasonCode OK', () => {
    const sr = buildStructuredResult(
      { available: true, reason: 'Room is available for the selected interval.' },
      baseInput(),
      660,
      720,
    );
    expect(sr.available).toBe(true);
    expect(sr.reasonCode).toBe('OK');
    expect(sr.durationMinutes).toBe(60);
    expect(sr.startLabel).toBe('11:00');
    expect(sr.endLabel).toBe('12:00');
    expect(sr.roomName).toBe('Test Room');
    expect(sr.bookedBy).toBeNull();
  });

  it('maps an AC4 overlap result and extracts bookedBy', () => {
    const sr = buildStructuredResult(
      { available: false, reason: 'Overlaps with existing booking (Alice).', ruleCode: 'AC4' },
      baseInput(),
      630,
      690,
    );
    expect(sr.reasonCode).toBe('AC4');
    expect(sr.bookedBy).toBe('Alice');
  });

  it('defaults unknown rule codes to VALIDATION', () => {
    const sr = buildStructuredResult(
      { available: false, reason: 'Something odd.', ruleCode: 'ZZ' as never },
      baseInput(),
      660,
      720,
    );
    expect(sr.reasonCode).toBe('VALIDATION');
  });

  it('uses VALIDATION when an unavailable result has no ruleCode', () => {
    const sr = buildStructuredResult(
      { available: false, reason: 'No room selected.' },
      baseInput(),
      660,
      720,
    );
    expect(sr.reasonCode).toBe('VALIDATION');
  });
});

describe('explainWithMock', () => {
  it('produces at most two sentences for an available slot', () => {
    const sr: ExplainStructuredResult = {
      available: true,
      reasonCode: 'OK',
      reason: 'Room is available.',
      startLabel: '11:00',
      endLabel: '12:00',
      currentTimeLabel: '09:00',
      roomName: 'Test Room',
      durationMinutes: 60,
      bookedBy: null,
      fallbackUsed: false,
    };
    const text = explainWithMock(sr);
    const sentenceCount = text.split('.').filter((s) => s.trim().length > 0).length;
    expect(sentenceCount).toBeLessThanOrEqual(2);
    expect(text).toContain('Test Room');
    expect(text).toContain('11:00');
    expect(text).toContain('12:00');
  });

  it('mentions the overlap and booker for AC4', () => {
    const sr: ExplainStructuredResult = {
      available: false,
      reasonCode: 'AC4',
      reason: 'Overlaps with existing booking (Alice).',
      startLabel: '11:00',
      endLabel: '12:00',
      currentTimeLabel: '09:00',
      roomName: 'Test Room',
      durationMinutes: 60,
      bookedBy: 'Alice',
      fallbackUsed: false,
    };
    const text = explainWithMock(sr);
    expect(text).toContain('overlaps');
    expect(text).toContain('Alice');
  });

  it('mentions the duration limit for AC2', () => {
    const sr: ExplainStructuredResult = {
      available: false,
      reasonCode: 'AC2',
      reason: 'Bookings cannot be longer than 120 minutes.',
      startLabel: '11:00',
      endLabel: '13:30',
      currentTimeLabel: '09:00',
      roomName: 'Test Room',
      durationMinutes: 150,
      bookedBy: null,
      fallbackUsed: false,
    };
    const text = explainWithMock(sr);
    expect(text).toContain('120-minute');
  });

  it('mentions blocked room for AC3', () => {
    const sr: ExplainStructuredResult = {
      available: false,
      reasonCode: 'AC3',
      reason: 'This room is currently blocked.',
      startLabel: '11:00',
      endLabel: '12:00',
      currentTimeLabel: '09:00',
      roomName: 'Test Room',
      durationMinutes: 60,
      bookedBy: null,
      fallbackUsed: false,
    };
    const text = explainWithMock(sr);
    expect(text).toContain('blocked');
  });

  it('AC1: start before current time says the start time has passed and names the current time', () => {
    const sr: ExplainStructuredResult = {
      available: false,
      reasonCode: 'AC1',
      reason: 'Start time must be after the current time (13:00).',
      startLabel: '09:00',
      endLabel: '10:00',
      currentTimeLabel: '13:00',
      roomName: 'Test Room',
      durationMinutes: 60,
      bookedBy: null,
      fallbackUsed: false,
    };
    const text = explainWithMock(sr);
    expect(text).toContain('13:00');
    expect(text).not.toContain('start before end');
  });

  it('AC1: start not before end says the start must be before the end', () => {
    const sr: ExplainStructuredResult = {
      available: false,
      reasonCode: 'AC1',
      reason: 'Start time must be before end time.',
      startLabel: '10:00',
      endLabel: '10:00',
      currentTimeLabel: '09:00',
      roomName: 'Test Room',
      durationMinutes: 0,
      bookedBy: null,
      fallbackUsed: false,
    };
    const text = explainWithMock(sr);
    expect(text).toContain('before the end');
  });
});

describe('validateExplanation', () => {
  it('accepts a short text with only input times', () => {
    const text = 'Test Room is free from 11:00 to 12:00.';
    const r = validateExplanation(text, baseInput(), 'OK');
    expect(r.valid).toBe(true);
  });

  it('rejects text containing a time not in the input and returns fallback', () => {
    const text = 'Test Room is free from 11:00 to 13:30 instead.';
    const r = validateExplanation(text, baseInput(), 'OK');
    expect(r.valid).toBe(false);
    expect(r.text).toBe('The room is available for the requested interval.');
  });

  it('rejects text longer than 300 characters and returns fallback', () => {
    const longText = 'Test Room is free from 11:00 to 12:00. ' + 'x'.repeat(300);
    const r = validateExplanation(longText, baseInput(), 'OK');
    expect(r.valid).toBe(false);
    expect(r.text.length).toBeLessThanOrEqual(MAX_EXPLANATION_LENGTH);
  });

  it('uses the fallback matching the AC4 reason code', () => {
    const text = 'The slot 11:00 to 08:30 overlaps an existing booking.';
    const r = validateExplanation(text, baseInput(), 'AC4');
    expect(r.valid).toBe(false);
    expect(r.text).toBe('The requested interval overlaps an existing booking.');
  });
});

describe('withTimeout', () => {
  it('resolves with the function value when it completes in time', async () => {
    const value = await withTimeout(() => 'fast result', EXPLAIN_TIMEOUT_MS);
    expect(value).toBe('fast result');
  });

  it('resolves with the TIMEOUT fallback when the function exceeds the limit', async () => {
    vi.useFakeTimers();
    const neverResolves = () => new Promise<string>(() => {});
    const promise = withTimeout(neverResolves, 10);
    vi.advanceTimersByTime(20);
    const value = await promise;
    expect(value).toBe('The explanation could not be generated in time.');
  });

  it('resolves with the ERROR fallback when the function throws', async () => {
    const value = await withTimeout(() => {
      throw new Error('boom');
    }, EXPLAIN_TIMEOUT_MS);
    expect(value).toBe('The explanation could not be generated.');
  });

  it('leaves no timer pending after a fast result', async () => {
    vi.useFakeTimers();
    await withTimeout(() => 'fast result', 500);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('explainAvailability (end to end)', () => {
  it('returns a validation fallback for empty input', async () => {
    const r = await explainAvailability(makeRoom(), makeBookings(), baseInput({ startText: '' }));
    expect(r.fallbackUsed).toBe(true);
    expect(r.reasonCode).toBe('VALIDATION');
  });

  it('returns a validation fallback for start >= end', async () => {
    const r = await explainAvailability(
      makeRoom(),
      makeBookings(),
      baseInput({ startText: '12:00', endText: '12:00' }),
    );
    expect(r.fallbackUsed).toBe(true);
    expect(r.reasonCode).toBe('VALIDATION');
  });

  it('returns an available explanation for a valid free slot', async () => {
    const r = await explainAvailability(makeRoom(), makeBookings(), baseInput());
    expect(r.fallbackUsed).toBe(false);
    expect(r.reasonCode).toBe('OK');
    expect(r.text).toContain('Test Room');
  });

  it('returns an AC4 explanation for an overlapping slot', async () => {
    const r = await explainAvailability(
      makeRoom(),
      makeBookings(),
      baseInput({ startText: '10:30', endText: '11:10' }),
    );
    expect(r.reasonCode).toBe('AC4');
    expect(r.text).toContain('overlaps');
  });

  it('returns an AC2 explanation for an over-long slot', async () => {
    const r = await explainAvailability(
      makeRoom(),
      [],
      baseInput({ startText: '11:00', endText: '13:30' }),
    );
    expect(r.reasonCode).toBe('AC2');
    expect(r.text).toContain('120-minute');
  });

  it('returns an AC3 explanation for a blocked room', async () => {
    const room = makeRoom();
    room.blocked = true;
    const r = await explainAvailability(room, [], baseInput());
    expect(r.reasonCode).toBe('AC3');
    expect(r.text).toContain('blocked');
  });

  it('AC1: past start time produces an explanation naming the current time', async () => {
    const r = await explainAvailability(
      makeRoom(),
      makeBookings(),
      baseInput({ startText: '09:00', endText: '10:00', currentTime: 780 }),
    );
    expect(r.reasonCode).toBe('AC1');
    expect(r.text).toContain('13:00');
    expect(r.text).not.toContain('before the end');
  });

  it('falls back when the mock output contains a time not in the input', async () => {
    // Force validateExplanation to reject by having the structured result carry a
    // start/end that the mock formats, but feed mismatched input labels.
    // We do this by spying on explainWithMock indirectly: explainAvailability uses
    // the real input labels, so we verify the guard via a direct call instead.
    const text = 'Room is free from 11:00 to 13:30.';
    const r = validateExplanation(text, baseInput(), 'OK');
    expect(r.valid).toBe(false);
  });
});
