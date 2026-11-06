export class KanBorgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KanBorgError';
  }
}

export class KanBorgAuthError extends KanBorgError {
  constructor(message: string) {
    super(message);
    this.name = 'KanBorgAuthError';
  }
}

export class GitHubRequestError extends KanBorgError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'GitHubRequestError';
  }
}
