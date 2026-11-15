/**
 * `cindy received …`: request and manage providers shared with this account.
 * The request is sent only after the user saw who shares what, where the Agent runs and
 * what passes through the sharer's computer (provider-sharing.md §4.1 step 3), then confirmed.
 */
import type { ProviderShareLinkPreview, ProviderShareRequestState } from '@cindy/device-link';
import type { Translate } from './i18n';
import { CliError } from './profile';
import { ShareError, type GuestShares } from './shares';

export interface ReceivedDeps {
  shares: GuestShares;
  t: Translate;
  output(line: string): void;
  /** Visible single-line answer from the trusted terminal. */
  ask(question: string): Promise<string>;
  /** Poll delay; rejects when the user stops waiting. */
  wait(ms: number): Promise<void>;
}

const POLL_MS = 4_000;

export function shareFailure(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ShareError) {
    const key = ({ INVALID_LINK: 'error.shareInvalidLink', OTHER_REGION: 'error.shareOtherRegion', NOT_FOUND: 'error.shareNotFound',
      PAUSED: 'error.sharePaused', REMOVED: 'error.shareRemoved', UNAVAILABLE: 'error.shareUnavailable' } as const)[error.code];
    return new CliError(`SHARE_${error.code}`, key);
  }
  return new CliError('SHARE_UNAVAILABLE', 'error.shareUnavailable');
}

function settled(state: ProviderShareRequestState, preview: ProviderShareLinkPreview, deps: ReceivedDeps): number {
  const vars = { name: preview.owner.displayName, provider: preview.providerLabel };
  if (state.status === 'approved') { deps.output(deps.t('received.approved', vars)); return 0; }
  if (state.status === 'rejected') { deps.output(deps.t('received.rejected', vars)); return 1; }
  if (state.status === 'withdrawn') { deps.output(deps.t('received.withdrawn')); return 1; }
  deps.output(deps.t('received.expired'));
  return 1;
}

export async function runReceived(args: readonly string[], deps: ReceivedDeps): Promise<number> {
  const { shares, t, output } = deps;
  const [action = 'list', value, ...rest] = args;
  if (rest.length) throw new CliError('INVALID_ARGUMENT', 'error.unexpectedArgument');
  try {
    if (action === 'list' && value === undefined) {
      const list = await shares.refresh();
      if (!list.length) { output(t('received.none')); return 0; }
      for (const share of list) {
        const status = share.status === 'active' ? t('received.statusActive') : t('received.statusPaused');
        output(t('received.row', { provider: share.providerLabel, name: share.owner.displayName, id: share.memberId,
          status: share.hostOnline || share.status !== 'active' ? status : `${status}, ${t('received.hostOffline')}` }));
      }
      return 0;
    }
    if (action === 'join' && value) {
      output(t('received.loading'));
      const preview = await shares.preview(value);
      const vars = { name: preview.owner.displayName, provider: preview.providerLabel };
      if (preview.state !== 'unused') { output(t('received.linkUsed', vars)); return 1; }
      output('');
      output(t('received.askTitle', vars));
      for (const key of ['received.factRuns', 'received.factFiles', 'received.factPrivacy', 'received.factApproval'] as const) output(`  • ${t(key, vars)}`);
      output('');
      const answer = (await deps.ask(t('received.confirm'))).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes' && answer !== '是') { output(t('received.cancelled')); return 1; }
      let state = await shares.request(value);
      output(t('received.pairing', { code: state.pairingCode }));
      output(t('received.waitDescription', vars));
      output(t('received.waiting', vars));
      while (state.status === 'pending') {
        try { await deps.wait(POLL_MS); }
        catch { output(t('received.stillPending', { id: state.requestId })); return 0; }
        try { state = await shares.status(state.requestId); }
        catch { /* Transient: keep waiting; the request stays on the service. */ }
      }
      if (state.status === 'approved') await shares.refresh().catch(() => undefined);
      return settled(state, preview, deps);
    }
    if (action === 'status' && value) {
      const state = await shares.status(value);
      if (state.status === 'pending') { output(t('received.pairing', { code: state.pairingCode })); output(t('received.stillPending', { id: state.requestId })); return 0; }
      output(t(state.status === 'approved' ? 'received.statusActive' : state.status === 'rejected' ? 'received.rejected' : state.status === 'withdrawn' ? 'received.withdrawn' : 'received.expired', { name: '', provider: '' }));
      return state.status === 'approved' ? 0 : 1;
    }
    if (action === 'withdraw' && value) {
      await shares.withdraw(value);
      output(t('received.withdrawn'));
      return 0;
    }
    if (action === 'leave' && value) {
      const list = await shares.refresh();
      if (!list.some(share => share.memberId === value)) throw new ShareError('NOT_FOUND');
      await shares.leave(value);
      output(t('received.left'));
      return 0;
    }
  } catch (error) { throw shareFailure(error); }
  output(t('received.usage'));
  return 1;
}
