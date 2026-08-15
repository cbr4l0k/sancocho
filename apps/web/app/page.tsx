'use client';

import { Authenticated, AuthLoading, Unauthenticated, useQuery } from 'convex/react';

import { api } from '@sancocho/convex/api';

export default function HomePage() {
  return (
    <main>
      <AuthLoading>
        <p>Connecting to Sancocho…</p>
      </AuthLoading>
      <Unauthenticated>
        <p>Not signed in. The Sancocho connection is ready when you are.</p>
      </Unauthenticated>
      <Authenticated>
        <ConnectionStatus />
      </Authenticated>
    </main>
  );
}

function ConnectionStatus() {
  const currentUser = useQuery(api.auth.queries.getCurrentUser);

  if (currentUser === undefined) {
    return <p>Connecting to Convex…</p>;
  }

  if (currentUser === null) {
    return <p>Connected to Convex. Your Sancocho user profile is not set up yet.</p>;
  }

  return <p>Connected to Convex.</p>;
}
