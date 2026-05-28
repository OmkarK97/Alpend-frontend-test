import { useState } from 'react';
import type { TransactionLog as TxLog } from '../types';
import { EXPLORER_URL } from '../config';

interface Props {
  logs: TxLog[];
}

export function TransactionLog({ logs }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (logs.length === 0) return null;

  return (
    <div className="activity-section">
      <button
        className="activity-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span>Activity</span>
        <span className="activity-badge">{logs.length}</span>
        <span className="activity-chevron">{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>

      {expanded && (
        <div className="activity-list">
          {logs.slice(0, 20).map((log) => (
            <div key={log.id} className={`activity-item activity-${log.status}`}>
              <span className={`activity-dot dot-${log.status}`} />
              <span className="activity-op">{log.operation}</span>
              <span className="activity-msg">{log.message}</span>
              {log.status === 'success' && log.updateId && (
                <a
                  href={`${EXPLORER_URL}/${log.updateId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="activity-explorer-link"
                >
                  View tx
                </a>
              )}
              <span className="activity-time">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              {log.details != null && (
                <details className="activity-details">
                  <summary>Details</summary>
                  <pre className="json-block">
                    {JSON.stringify(log.details, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
