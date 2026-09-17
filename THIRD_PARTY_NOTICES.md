# Third-party notices

## David Li — Fluid Particles

The MAC-grid texture atlas, weighted particle-to-grid splatting and PIC/FLIP transfer equations in `src/fluid/shaders.ts` are adapted from and informed by [dli/fluid](https://github.com/dli/fluid), revision `ac3ee551ee33caaf4c0aa38da21e2be5562fd5ab`.

RealWater replaces the original app and renderer, adds a finite moving open container, particle injection/recycling, world-space collision handling, implicit liquid surface reconstruction, touch/sensor controls, and WebGL2 / TypeScript integration. The original project is not claimed to implement these additions.

The MIT License (MIT)

Copyright (c) 2016 David Li (http://david.li)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Liquid surface reconstruction

The weighted particle-position implicit surface in `src/fluid/implicit-shaders.ts` and its CPU reference in `src/fluid/surface-field.ts` follow the mathematical method in Yongning Zhu and Robert Bridson, [Animating Sand as a Fluid](https://www.cs.ubc.ca/~rbridson/docs/zhu-siggraph05-sandfluid.pdf), ACM SIGGRAPH 2005. RealWater extends this method with a tiled GPU volume, relative-position and squared-distance moments, density-dependent radii, gap rejection, spatial smoothing and ray/isosurface intersection. No source code from that paper was copied.

## Affine particle/grid transfer

The APIC velocity-gradient gather and affine scatter in `src/fluid/shaders.ts` implement the method of Chenfanfu Jiang, Craig Schroeder, Andrew Selle, Joseph Teran and Alexey Stomakhin, [The Affine Particle-In-Cell Method](https://www.andyselle.com/papers/24/), SIGGRAPH 2015 ([technical report](https://www.cs.ucr.edu/~craigs/papers/2015-apic/tech-doc.pdf)). RealWater uses staggered MAC velocities and multilinear weights; gradients are evaluated directly to avoid singular moment-matrix inversion on grid planes. No source code from the paper was copied. The earlier dli/fluid attribution and license above continue to apply to the adapted grid and transfer infrastructure.

## Runtime packages

- Three.js: MIT, https://github.com/mrdoob/three.js

Complete package versions are recorded in `package-lock.json`. Dependencies retain their own distributed license files.
