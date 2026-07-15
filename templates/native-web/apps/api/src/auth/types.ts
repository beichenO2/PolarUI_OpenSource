export type UserStatus = 'active' | 'disabled';
export type UserCreatedVia = 'registration' | 'admin_cli';

export interface PublicUser {
  id: string;
  email: string;
  username: string;
}
