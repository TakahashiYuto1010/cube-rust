import { createContext, useState, useEffect, ReactNode } from 'react';
import jwtDecode from 'jwt-decode';

import { SecurityContext } from './SecurityContext';
import { useIsMounted, useLocalStorage } from '../../hooks';

export type SecurityContextProps = {
  payload: string;
  token: string | null;
  isModalOpen: boolean;
  setIsModalOpen: any;
  saveToken: (token: string | null) => void;
  onTokenPayloadChange: (payload: string) => Promise<string>;
};

export const SecurityContextContext = createContext<SecurityContextProps>(
  {} as SecurityContextProps
);

export type SecurityContextProviderProps = {
  children: ReactNode;
  tokenUpdater?: (token: string | null) => Promise<string | null>;
} & Pick<SecurityContextProps, 'onTokenPayloadChange'>;

let mutex = 0;
let refreshingToken: string | null = null;

export function SecurityContextProvider({
  children,
  tokenUpdater,
  onTokenPayloadChange,
}: SecurityContextProviderProps) {
  const isMounted = useIsMounted();
  const [token, setToken, removeToken] = useLocalStorage<string | null>(
    'cubejsToken',
    null
  );
  const [payload, setPayload] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    async function updateToken(token: string | null) {
      if (token != null && tokenUpdater && refreshingToken !== token) {
        refreshingToken = token;
        const currentMutext = mutex;
        const refreshedToken = await tokenUpdater(token);

        if (isMounted && currentMutext === mutex) {
          setToken(refreshedToken);
          mutex++;
        }
      }
    }

    updateToken(token);
  });

  useEffect(() => {
    if (token) {
      try {
        const payload = jwtDecode(token);
        setPayload(JSON.stringify(payload, null, 2));
      } catch (error) {
        setPayload('');
        console.error('Invalid JWT token');
      }
    } else {
      setPayload('');
    }
  }, [token]);

  return (
    <SecurityContextContext.Provider
      value={{
        token,
        payload,
        isModalOpen,
        setIsModalOpen,
        saveToken: (token) => {
          if (!token) {
            removeToken();
          } else {
            setToken(token);
          }
        },
        onTokenPayloadChange,
      }}
    >
      {children}
      <SecurityContext />
    </SecurityContextContext.Provider>
  );
}
