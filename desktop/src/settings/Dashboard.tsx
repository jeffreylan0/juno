/**
 * The top of settings: the account (in builds with accounts), this month's
 * answers, and who answers, at a glance. The settings themselves follow,
 * the most used first (Options.tsx).
 */
import { useEffect, useState } from 'react';
import { ACCOUNTS } from '@/lib/account/config';
import type { KeyStatus } from '@/lib/providers/types';
import { ASSISTANT, COMPANY, MODEL_NAMES, MODEL_TABLE } from '@/lib/router';
import type { Settings } from '@/lib/storage';
import { thisMonth, usageItem, type MonthUsage } from '@/lib/usage';
import type { AccountState } from '@/ui/useAccount';
import { AccountCard } from './Account';

export function Dashboard({ settings, keys, account }: { settings: Settings; keys: KeyStatus; account: AccountState }) {
  const usage = useMonthUsage();
  return (
    <section id="dashboard" className="dashboard" data-testid="dashboard">
      {ACCOUNTS && (
        <div id="account" className="dash-card" data-testid="dash-account">
          <h2>Account</h2>
          <AccountCard account={account} />
        </div>
      )}
      <div className="dash-card" data-testid="dash-usage">
        <h2>This month</h2>
        <p className="dash-big" data-testid="answers-this-month">
          {usage.answers} {usage.answers === 1 ? 'answer' : 'answers'}
        </p>
        {usage.costUsd >= 0.005 && (
          <p className="help" data-testid="spend-this-month">
            About ${usage.costUsd.toFixed(2)} on your API key
          </p>
        )}
        <p className="help dash-who" data-testid="who-answers">
          {whoAnswers(settings, keys)} ·{' '}
          <a className="link" href="#answers">
            Change
          </a>
        </p>
      </div>
    </section>
  );
}

/** Who answers, as one line. */
function whoAnswers(s: Settings, keys: KeyStatus): string {
  switch (s.provider) {
    case 'byok': {
      const model = s.modelOverride?.vendor === s.vendor ? s.modelOverride.model : MODEL_TABLE[s.vendor].large;
      const key = keys[s.vendor] ? `your ${COMPANY[s.vendor]} key ${keys[s.vendor]}` : `no ${COMPANY[s.vendor]} key yet`;
      return `${ASSISTANT[s.vendor]}, ${MODEL_NAMES[model] ?? model}, with ${key}`;
    }
    case 'local':
      return `The local model ${s.localModel}`;
    case 'gateway':
      return 'Hosted answers, with your plan';
    default:
      return 'No one yet';
  }
}

function useMonthUsage(): MonthUsage {
  const [usage, setUsage] = useState<MonthUsage>(() => thisMonth(null));
  useEffect(() => {
    void usageItem.getValue().then((u) => setUsage(thisMonth(u)), () => {});
    return usageItem.watch((u) => setUsage(thisMonth(u)));
  }, []);
  return usage;
}
