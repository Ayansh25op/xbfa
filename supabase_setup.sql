-- 1. Create a table for user roles
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'visitor'
);

-- 2. Create a profiles table for user management
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  username TEXT UNIQUE,
  role TEXT DEFAULT 'visitor',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. Data Tables
CREATE TABLE IF NOT EXISTS public.seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  jersey_number INTEGER,
  pos TEXT,
  rating INTEGER DEFAULT 0,
  photo TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID REFERENCES public.seasons(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  title TEXT,
  team_a UUID[] DEFAULT '{}',
  team_b UUID[] DEFAULT '{}',
  events JSONB DEFAULT '[]',
  score_a INTEGER DEFAULT 0,
  score_b INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.match_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID REFERENCES public.matches(id) ON DELETE CASCADE,
  player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  rating DECIMAL(3,1),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- End of Season Awards
CREATE TABLE IF NOT EXISTS public.awards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID REFERENCES public.seasons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 6. Match Awards Table (STRICTLY SEPARATE)
CREATE TABLE IF NOT EXISTS public.match_awards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID REFERENCES public.matches(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'mvp', 'lvp', 'gk'
  player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 4. Enable Row Level Security
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_awards ENABLE ROW LEVEL SECURITY;

-- 4.1 Policies
CREATE POLICY "Allow all for authenticated users" ON public.players FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.players FOR SELECT TO public USING (true);

CREATE POLICY "Allow all for authenticated users" ON public.matches FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.matches FOR SELECT TO public USING (true);

CREATE POLICY "Allow all for authenticated users" ON public.seasons FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.seasons FOR SELECT TO public USING (true);

CREATE POLICY "Allow all for authenticated users" ON public.match_ratings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.match_ratings FOR SELECT TO public USING (true);

CREATE POLICY "Allow all for authenticated users" ON public.awards FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.awards FOR SELECT TO public USING (true);

CREATE POLICY "Allow all for authenticated users" ON public.match_awards FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.match_awards FOR SELECT TO public USING (true);

CREATE POLICY "Allow users to read their own role" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Allow users to read profiles" ON public.profiles FOR SELECT TO authenticated USING (true);

-- 5. Trigger for new users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Insert into user_roles
  INSERT INTO public.user_roles (user_id, role)
  VALUES (new.id, 'visitor');

  -- Insert into profiles
  INSERT INTO public.profiles (id, username, role)
  VALUES (new.id, new.email, 'visitor');

  RETURN new;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
