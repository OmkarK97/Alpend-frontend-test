import { useState, useEffect } from 'react';
import { useLoop } from './hooks/useLoop';
import { usePosition } from './hooks/usePosition';
import { ConnectWallet } from './components/ConnectWallet';
import { Dashboard } from './components/Dashboard';
import { DashboardSkeleton } from './components/DashboardSkeleton';
import { AdminPage } from './components/AdminPage';
import { TransferPage } from './components/TransferPage';
import { LiquidationsPage } from './components/LiquidationsPage';
import { TransactionLog } from './components/TransactionLog';
import { AlpendV2 } from './v2/AlpendV2';

export default function App() {
  const {
    provider,
    partyId,
    isConnecting,
    isRestoring,
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
  const isLiquidations = route === '#/liquidations';

  // Clean v2 surface — full-page takeover at #/v2, isolated from the classic app.
  if (route === '#/v2') {
    return (
      <AlpendV2
        position={position}
        partyId={partyId}
        isConnected={isConnected}
        isConnecting={isConnecting}
        connect={connect}
        disconnect={disconnect}
        submitTx={submitTx}
        addLog={addLog}
        onExit={() => {
          window.location.hash = '#/';
        }}
      />
    );
  }

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
            className={`header-link ${!isAdmin && !isTransfer && !isLiquidations ? 'header-link-active' : ''}`}
          >
            Dashboard
          </a>
          <a
            href="#/liquidations"
            className={`header-link ${isLiquidations ? 'header-link-active' : ''}`}
          >
            Liquidations
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
            // Show the header as "connecting" while restoring too, so it doesn't flash "Connect".
            isConnecting={isConnecting || isRestoring}
            partyId={partyId}
            onConnect={connect}
            onDisconnect={disconnect}
          />
        </div>
      </header>

      <main className="app-main">
        {isTransfer ? (
          <TransferPage partyId={partyId} />
        ) : isRestoring && !isConnected ? (
          // Session restore in flight (autoConnect is async). Show the dashboard's own shape
          // filling in rather than flashing a "not connected" prompt at someone who IS —
          // it becomes the real dashboard the moment the session restores.
          <DashboardSkeleton />
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
        ) : isLiquidations ? (
          <LiquidationsPage
            partyId={partyId}
            position={position}
            submitTx={submitTx}
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
