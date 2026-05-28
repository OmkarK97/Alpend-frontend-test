import { useEffect } from 'react';
import { EXPLORER_URL } from '../config';

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  successMessage?: string;
  updateId?: string;
}

export function ActionModal({ title, onClose, children, successMessage, updateId }: Props) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const showSuccess = !!successMessage;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{showSuccess ? 'Transaction Successful' : title}</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          {showSuccess ? (
            <div className="modal-success">
              <div className="success-icon">
                <svg viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="success-title">{successMessage}</div>
              {updateId && (
                <a
                  href={`${EXPLORER_URL}/${updateId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="success-explorer-link"
                >
                  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  View on Explorer
                </a>
              )}
              <button className="btn-done" onClick={onClose}>Done</button>
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}
