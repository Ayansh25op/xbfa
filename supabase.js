import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

export const supabaseUrl = "https://dmgqttbckvetarvuojnu.supabase.co";
export const anonKey = "sb_publishable_ZyJksRiLa46QNavFfoeaDA_liZMxOeT";

export const supabase = createClient(supabaseUrl, anonKey);
