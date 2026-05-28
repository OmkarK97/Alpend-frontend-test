interface Props {
  isConnected: boolean;
  isConnecting: boolean;
  partyId: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

function truncateParty(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

export function ConnectWallet({
  isConnected,
  isConnecting,
  partyId,
  onConnect,
  onDisconnect,
}: Props) {
  if (isConnected) {
    return (
      <div className="wallet-connected">
        <span className="wallet-dot" />
        <span className="wallet-address" title={partyId}>
          {truncateParty(partyId)}
        </span>
        <button onClick={onDisconnect} className="wallet-disconnect-btn">
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onConnect}
      disabled={isConnecting}
      className="wallet-connect-btn"
    >
      {isConnecting ? 'Connecting...' : 'Connect Wallet'}
    </button>
  );
}
