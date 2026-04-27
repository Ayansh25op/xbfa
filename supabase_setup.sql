-- 1. Create a table for user roles
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'visitor'
);

-- Ensure email column exists if table was created earlier
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_roles' AND column_name='email') THEN
        ALTER TABLE public.user_roles ADD COLUMN email TEXT;
    END IF;
END $$;

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
  goals INTEGER DEFAULT 0,
  matches INTEGER DEFAULT 0,
  avg_rating DECIMAL(3,1) DEFAULT 0,
  latest_rating DECIMAL(3,1),
  photo TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Ensure goals and matches columns exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='players' AND column_name='goals') THEN
        ALTER TABLE public.players ADD COLUMN goals INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='players' AND column_name='matches') THEN
        ALTER TABLE public.players ADD COLUMN matches INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='players' AND column_name='avg_rating') THEN
        ALTER TABLE public.players ADD COLUMN avg_rating DECIMAL(3,1) DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='players' AND column_name='latest_rating') THEN
        ALTER TABLE public.players ADD COLUMN latest_rating DECIMAL(3,1);
    END IF;
END $$;

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

-- Ensure events and other columns exist if table was created earlier without them
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='matches' AND column_name='events') THEN
        ALTER TABLE public.matches ADD COLUMN events JSONB DEFAULT '[]';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='matches' AND column_name='team_a') THEN
        ALTER TABLE public.matches ADD COLUMN team_a UUID[] DEFAULT '{}';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='matches' AND column_name='team_b') THEN
        ALTER TABLE public.matches ADD COLUMN team_b UUID[] DEFAULT '{}';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='matches' AND column_name='score_a') THEN
        ALTER TABLE public.matches ADD COLUMN score_a INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='matches' AND column_name='score_b') THEN
        ALTER TABLE public.matches ADD COLUMN score_b INTEGER DEFAULT 0;
    END IF;
END $$;

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
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.players;
DROP POLICY IF EXISTS "Allow select for everyone" ON public.players;
CREATE POLICY "Allow all for authenticated users" ON public.players FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.players FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.matches;
DROP POLICY IF EXISTS "Allow select for everyone" ON public.matches;
CREATE POLICY "Allow all for authenticated users" ON public.matches FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.matches FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.seasons;
DROP POLICY IF EXISTS "Allow select for everyone" ON public.seasons;
CREATE POLICY "Allow all for authenticated users" ON public.seasons FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.seasons FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.match_ratings;
DROP POLICY IF EXISTS "Allow select for everyone" ON public.match_ratings;
CREATE POLICY "Allow all for authenticated users" ON public.match_ratings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.match_ratings FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.awards;
DROP POLICY IF EXISTS "Allow select for everyone" ON public.awards;
CREATE POLICY "Allow all for authenticated users" ON public.awards FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow select for everyone" ON public.awards FOR SELECT TO public USING (true);

-- 117
DROP POLICY IF EXISTS "match_awards_authenticated_all" ON public.match_awards;
DROP POLICY IF EXISTS "match_awards_public_select" ON public.match_awards;
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.match_awards;
DROP POLICY IF EXISTS "Allow select for everyone" ON public.match_awards;
DROP POLICY IF EXISTS "match_awards_all_access" ON public.match_awards;

CREATE POLICY "match_awards_all_access" ON public.match_awards FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow users to read their own role" ON public.user_roles;
DROP POLICY IF EXISTS "Allow admins to manage all roles" ON public.user_roles;
CREATE POLICY "Allow users to read their own role" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id OR (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')) OR (SELECT auth.jwt() ->> 'email') = 'admin@xbfa.com');
CREATE POLICY "Allow admins to manage all roles" ON public.user_roles FOR ALL TO authenticated USING ((EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')) OR (SELECT auth.jwt() ->> 'email') = 'admin@xbfa.com');

DROP POLICY IF EXISTS "Allow users to read profiles" ON public.profiles;
DROP POLICY IF EXISTS "Allow admins to manage all profiles" ON public.profiles;
CREATE POLICY "Allow users to read profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow admins to manage all profiles" ON public.profiles FOR ALL TO authenticated USING ((EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')) OR (SELECT auth.jwt() ->> 'email') = 'admin@xbfa.com');

DROP POLICY IF EXISTS "Allow select for everyone" ON public.user_roles;
CREATE POLICY "Allow select for everyone" ON public.user_roles FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "allow delete" ON public.user_roles;
CREATE POLICY "allow delete" ON public.user_roles FOR DELETE USING (true);

-- 5. Trigger for new users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Insert into user_roles
  INSERT INTO public.user_roles (user_id, email, role)
  VALUES (new.id, new.email, 'visitor');

  -- Insert into profiles
  INSERT INTO public.profiles (id, username, role)
  VALUES (new.id, new.email, 'visitor');

  RETURN new;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
