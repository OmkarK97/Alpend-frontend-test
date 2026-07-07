import { useState, useEffect } from 'react';
import { useLoop } from './hooks/useLoop';
import { usePosition } from './hooks/usePosition';
import { ConnectWallet } from './components/ConnectWallet';
import { Dashboard } from './components/Dashboard';
import { AdminPage } from './components/AdminPage';
import { TransferPage } from './components/TransferPage';
import { TransactionLog } from './components/TransactionLog';

export default function App() {
  const {
    provider,
    partyId,
    isConnecting,
    isConnected,
    connect,
    disconnect,
    submitTx,
    logs,
    addLog,
  } = useLoop();

  const position = usePosition(provider, partyId);

  const [route, setRoute] = useState(window.location.hash || '#/');

  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const isAdmin = route === '#/admin';
  const isTransfer = route === '#/transfer';

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="header-logo">Alpend</h1>
          <span className="header-subtitle">Lending</span>
          <span className="network-badge">testnet</span>
        </div>
        <nav className="header-nav">
          <a
            href="#/"
            className={`header-link ${!isAdmin && !isTransfer ? 'header-link-active' : ''}`}
          >
            Dashboard
          </a>
          <a
            href="#/transfer"
            className={`header-link ${isTransfer ? 'header-link-active' : ''}`}
          >
            Transfer
          </a>
          <a
            href="#/admin"
            className={`header-link ${isAdmin ? 'header-link-active' : ''}`}
          >
            Admin
          </a>
        </nav>
        <div className="header-right">
          <ConnectWallet
            isConnected={isConnected}
            isConnecting={isConnecting}
            partyId={partyId}
            onConnect={connect}
            onDisconnect={disconnect}
          />
        </div>
      </header>

      <main className="app-main">
        {isTransfer ? (
          <TransferPage partyId={partyId} />
        ) : !isConnected ? (
          <div className="connect-prompt">
            <div className="connect-prompt-card">
              <h2>Welcome to Alpend Lending</h2>
              <p>Connect your Loop wallet to supply, borrow, and manage your positions.</p>
              <button
                onClick={connect}
                disabled={isConnecting}
                className="btn-connect-large"
              >
                {isConnecting ? 'Connecting...' : 'Connect Loop Wallet'}
              </button>
            </div>
          </div>
        ) : isAdmin ? (
          <AdminPage
            partyId={partyId}
            provider={provider}
            submitTx={submitTx}
            addLog={addLog}
          />
        ) : (
          <Dashboard
            partyId={partyId}
            provider={provider}
            position={position}
            submitTx={submitTx}
            addLog={addLog}
            logs={logs}
          />
        )}
      </main>

      {isConnected && !isAdmin && logs.length > 0 && (
        <TransactionLog logs={logs} />
      )}
    </div>
  );
}
