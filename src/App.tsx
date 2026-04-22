/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Volume2, Heart, Sparkles } from 'lucide-react';

export default function App() {
  const [quackCount, setQuackCount] = useState(0);
  const [isQuacking, setIsQuacking] = useState(false);

  const handleQuack = () => {
    setQuackCount(prev => prev + 1);
    setIsQuacking(true);
    setTimeout(() => setIsQuacking(false), 300);
    
    // Play a subtle sound if we could, but for now we focus on visual feedback
  };

  return (
    <div className="min-h-screen bg-[#FFFBEB] flex flex-col items-center justify-center p-6 font-sans text-[#451a03]">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full text-center space-y-8"
      >
        <header className="space-y-2">
          <motion.h1 
            className="text-5xl font-display font-bold tracking-tight text-[#f59e0b]"
            animate={isQuacking ? { scale: 1.1 } : { scale: 1 }}
          >
            Duck Haven
          </motion.h1>
          <p className="text-lg opacity-80 italic">A small space for a big duck.</p>
        </header>

        <div className="relative group">
          <motion.div
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="rounded-3xl overflow-hidden shadow-2xl border-8 border-white bg-white aspect-square relative"
          >
            <img 
              src="https://images.unsplash.com/photo-1555850831-1554737482c3?auto=format&fit=crop&q=80&w=1000"
              alt="A cute yellow duckling"
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
            
            {/* Overlay indicators */}
            <AnimatePresence>
              {isQuacking && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.5, y: 20 }}
                  animate={{ opacity: 1, scale: 1.2, y: -20 }}
                  exit={{ opacity: 0, scale: 0.5 }}
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                >
                  <span className="bg-white px-6 py-2 rounded-full font-display font-bold text-2xl shadow-lg border-2 border-[#f59e0b]">
                    QUACK!
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* Floating elements */}
          <motion.div 
            animate={{ 
              y: [0, -10, 0],
            }}
            transition={{ 
              duration: 2, 
              repeat: Infinity,
              ease: "easeInOut"
            }}
            className="absolute -top-4 -right-4 bg-white p-3 rounded-2xl shadow-lg border border-amber-100"
          >
            <Sparkles className="w-6 h-6 text-amber-400" />
          </motion.div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-amber-100 flex flex-col items-center">
            <Heart className="w-6 h-6 text-rose-500 mb-1" />
            <span className="text-xs uppercase font-bold tracking-widest opacity-60">Love level</span>
            <span className="text-xl font-display font-bold">Infinite</span>
          </div>
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-amber-100 flex flex-col items-center">
            <Volume2 className="w-6 h-6 text-blue-500 mb-1" />
            <span className="text-xs uppercase font-bold tracking-widest opacity-60">Total Quacks</span>
            <span className="text-xl font-display font-bold">{quackCount}</span>
          </div>
        </div>

        <button
          id="quack-button"
          onClick={handleQuack}
          className="w-full bg-[#f59e0b] hover:bg-[#d97706] text-white font-display font-bold py-4 px-8 rounded-2xl shadow-xl transition-all active:transform active:scale-95 flex items-center justify-center gap-3 text-xl"
        >
          <Volume2 className="w-6 h-6" />
          QUACK AT DUCK
        </button>

        <footer className="pt-8 border-t border-amber-100/50">
          <p className="text-xs opacity-40 uppercase tracking-[0.2em] font-medium">
            Project Anatidae • 2026
          </p>
        </footer>
      </motion.div>
    </div>
  );
}

