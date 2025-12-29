import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export function useCurrentWallet() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchWallet = async () => {
      try {
        const { data, error } = await supabase
          .from('bot_config')
          .select('polymarket_address')
          .limit(1)
          .single();

        if (error) throw error;
        setWalletAddress(data?.polymarket_address || null);
      } catch (err) {
        console.error('Error fetching wallet:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchWallet();
  }, []);

  return { walletAddress, isLoading };
}
