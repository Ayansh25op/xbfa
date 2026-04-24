import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

export const supabase = createClient(
  "https://dmgqttbckvetarvuojnu.supabase.co",
  "sb_publishable_ZyJksRiLa46QNavFfoeaDA_liZMxOeT"
);

if (!supabaseUrl || !supabaseKey) {
    console.error("Supabase environment variables are missing! Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.");
}
