/** Button looks, shared so a Save is a Save on every tab. */
export const btn = {
  primary:   'h-11 px-4 rounded-xl text-sm font-semibold bg-cyan-500/80 text-white active:scale-95 transition disabled:bg-white/5 disabled:text-white/30 disabled:active:scale-100',
  secondary: 'h-11 px-4 rounded-xl text-sm font-semibold bg-white/10 text-white/75 border border-white/10 active:scale-95 transition disabled:opacity-40',
  danger:    'h-11 px-4 rounded-xl text-sm font-bold bg-red-500 text-white active:scale-95 transition',
  chip:      (on: boolean) => `h-10 px-3 rounded-xl text-[12.5px] font-semibold border transition active:scale-95 ${
    on ? 'bg-cyan-500/20 text-cyan-50 border-cyan-400/45' : 'bg-white/5 text-white/55 border-transparent'}`,
}
