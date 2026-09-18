# Creator Studio frontend

React/Vite admin dashboard. Source is in `src/`; the production build is in `dist/`.
This project has its own dependencies and lockfile.

```sh
npm ci
npm run build
```

The sibling backend serves this build at http://localhost:4000 by default.
For hot reload, set `ADMIN_ORIGIN=http://localhost:5173` on the backend, start it,
then run `npm run dev` here and open http://localhost:5173. API and media requests
are proxied to port 4000, keeping authentication on the dashboard's origin.

`npm run preview` previews the compiled dashboard at http://localhost:4173 with
an API proxy; set backend `ADMIN_ORIGIN=http://localhost:4173` for that mode.

See the [workspace instructions](../README.md) for mobile and backend setup.
