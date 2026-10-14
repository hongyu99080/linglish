(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishRoleplayState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STATES = Object.freeze([
    'catalog',
    'starting',
    'ready',
    'ai_speaking',
    'recording',
    'recognizing',
    'evaluating',
    'review',
    'recoverable_error',
  ]);

  function createRoleplayStateMachine(options = {}) {
    const now = typeof options.now === 'function' ? options.now : Date.now;
    let state = {
      status: 'catalog',
      generation: 0,
      session: null,
      transcript: '',
      turn: null,
      error: null,
      retryStatus: null,
      exited: false,
      updatedAt: now(),
    };

    function snapshot() {
      return { ...state };
    }

    function update(patch) {
      state = { ...state, ...patch, updatedAt: now() };
      return true;
    }

    function currentGeneration(event) {
      return Number.isInteger(event.generation)
        && event.generation === state.generation;
    }

    function dispatch(event = {}) {
      switch (event.type) {
        case 'SESSION_START':
          if (state.status !== 'catalog' && state.status !== 'recoverable_error') return false;
          return update({
            status: 'starting',
            generation: state.generation + 1,
            session: null,
            transcript: '',
            turn: null,
            error: null,
            retryStatus: null,
            exited: false,
          });

        case 'SESSION_READY':
          if (!event.session || (state.status !== 'catalog' && state.status !== 'starting')) return false;
          return update({
            status: 'ready',
            generation: state.status === 'catalog' ? state.generation + 1 : state.generation,
            session: event.session,
            transcript: '',
            turn: null,
            error: null,
            retryStatus: null,
            exited: false,
          });

        case 'AI_PLAY_STARTED':
          if (state.status !== 'ready') return false;
          return update({ status: 'ai_speaking' });

        case 'AI_PLAY_ENDED':
          if (state.status !== 'ai_speaking' || !currentGeneration(event)) return false;
          return update({ status: 'ready' });

        case 'RECORDING_STARTED':
          if (state.status !== 'ready') return false;
          return update({ status: 'recording', transcript: '', error: null });

        case 'RECORDING_STOPPED':
          if (state.status !== 'recording') return false;
          return update({ status: 'recognizing' });

        case 'RECORDING_CANCELLED':
          if (
            (state.status !== 'recording' && state.status !== 'recognizing')
            || !currentGeneration(event)
          ) return false;
          return update({
            status: 'ready',
            generation: state.generation + 1,
            transcript: '',
            error: null,
          });

        case 'RECOGNITION_DONE':
          if (
            (state.status !== 'recording' && state.status !== 'recognizing')
            || !currentGeneration(event)
            || typeof event.transcript !== 'string'
            || !event.transcript.trim()
          ) return false;
          return update({ status: 'evaluating', transcript: event.transcript.trim() });

        case 'AI_DONE':
          if (state.status !== 'evaluating' || !currentGeneration(event) || !event.turn) return false;
          return update({
            status: event.reviewReady ? 'review' : 'ai_speaking',
            turn: event.turn,
            error: null,
          });

        case 'REDO_RECORDING':
          if (state.status !== 'evaluating') return false;
          return update({
            status: 'ready',
            generation: state.generation + 1,
            transcript: '',
            error: null,
          });

        case 'REVIEW_READY':
          if (
            state.status !== 'ready'
            && state.status !== 'ai_speaking'
            && state.status !== 'evaluating'
          ) return false;
          return update({ status: 'review', turn: event.review || state.turn });

        case 'RECOVERABLE_ERROR': {
          if (state.status === 'review' || state.status === 'recoverable_error') return false;
          const retryStatus = state.status === 'evaluating'
            ? 'evaluating'
            : (state.session ? 'ready' : 'catalog');
          return update({
            status: 'recoverable_error',
            error: { code: String(event.code || 'AI_ROLEPLAY_ERROR') },
            retryStatus,
          });
        }

        case 'RETRY':
          if (state.status !== 'recoverable_error') return false;
          const nextStatus = state.retryStatus || (state.session ? 'ready' : 'catalog');
          return update({
            status: nextStatus,
            generation: state.generation + 1,
            error: null,
            retryStatus: null,
            transcript: nextStatus === 'evaluating' ? state.transcript : '',
          });

        case 'PAGE_EXIT':
          return update({
            status: 'catalog',
            generation: state.generation + 1,
            session: null,
            transcript: '',
            turn: null,
            error: null,
            retryStatus: null,
            exited: true,
          });

        default:
          return false;
      }
    }

    return { dispatch, snapshot };
  }

  return { STATES, createRoleplayStateMachine };
});
