# The blur-recovery attack

The thirty-second proof that blur is not redaction.

```
node tools/attack-deblur/attack.mjs              # run, write images to out/
node tools/attack-deblur/attack.mjs --self-test  # assert: blur breaks, flat fill holds
```

A Luhn-valid card number is rendered in a known font, blurred with a Gaussian
whose kernel radius is five times the stroke width (unreadable to the eye),
and then recovered by coordinate descent: hold the estimate of every other
digit fixed, render each candidate in place, blur identically, compare over
the cell plus its blur halo. Three sweeps recover all sixteen digits.

The same attack against the flat fill Kavach actually sends recovers a
constant string at chance-level accuracy: every cell ranks the candidates
identically because the fill carries zero information about what was under it.

Outputs:

| file | what it shows |
|---|---|
| `1-original.png` | the rendered card number |
| `2-blurred.png` | what a blur-based "redaction" ships |
| `3-flat-fill.png` | what Kavach ships |
| `4-recovered-from-blur.png` | the attacker's reconstruction from the blur |

No dependencies; the PNG encoder is 60 lines over node:zlib.
