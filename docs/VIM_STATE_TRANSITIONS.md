# Vim Mode State Transition Model

## Overview
Min's vim mode uses a finite state machine with 5 distinct states. Each state has specific transition conditions and target states.

## State Definitions
- **NORMAL**: Default browsing mode, accepts vim commands
- **SEARCH**: Active search input mode, typing search queries
- **VISUAL**: Text selection mode, operates on selected text
- **LINK_HINT**: Link hinting mode, shows keyboard shortcuts for clickable elements
- **INPUT_FOCUS**: Input field focus mode, captures all keyboard input

## State Transition Table

### NORMAL State
| Next State | Condition |
|------------|-----------|
| SEARCH | Press `/` key |
| VISUAL | Press `v` key AND current text selection exists (selection not empty) |
| LINK_HINT | Press `f`, `F`, or `c` key AND not currently in input field |
| INPUT_FOCUS | Auto-triggered when any input field receives focus |

### SEARCH State
| Next State | Condition |
|------------|-----------|
| NORMAL | Press `Enter` key (always returns to NORMAL, may have selected text or not) |

### VISUAL State
| Next State | Condition |
|------------|-----------|
| NORMAL | Press `Ctrl+C` (global exit) |

### LINK_HINT State
| Next State | Condition |
|------------|-----------|
| NORMAL | Complete link hint selection OR press `Ctrl+C` |

### INPUT_FOCUS State
| Next State | Condition |
|------------|-----------|
| NORMAL | Input field loses focus AND no other input field has focus |

## Global Transitions
| From Any State | Next State | Condition |
|----------------|------------|-----------|
| Any | NORMAL | Press `Ctrl+C` (emergency exit) |

## Key Implementation Notes
- SEARCH never transitions directly to VISUAL - it always returns to NORMAL first
- VISUAL mode requires existing text selection (not search history)
- INPUT_FOCUS is automatically triggered by DOM focus events
- All transitions use the VimStateManager.transition() method with proper lifecycle hooks