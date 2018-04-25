import {resetAtmosphere} from 'universal/components/AtmosphereProvider/AtmosphereProvider';
import {showSuccess} from 'universal/modules/toast/ducks/toastDuck';
import SendClientSegmentEventMutation from 'universal/mutations/SendClientSegmentEventMutation';
import {reset as resetAppState} from 'universal/redux/rootDuck';
import {APP_TOKEN_KEY, APP_UPGRADE_PENDING_KEY, APP_UPGRADE_PENDING_RELOAD} from 'universal/utils/constants';

const signoutSuccess = {
  title: 'Tootles!',
  message: 'You’ve been logged out successfully.'
};

const signout = (atmosphere, dispatch, history) => {
  window.localStorage.removeItem(APP_TOKEN_KEY);
  resetAtmosphere();
  const reloadPendingState = window.sessionStorage.getItem(APP_UPGRADE_PENDING_KEY);
  SendClientSegmentEventMutation(atmosphere, 'User Logout');
  /* reset the app state, but preserve any pending notifications: */
  if (history) {
    history.replace('/');
  }
  dispatch(resetAppState());
  if (reloadPendingState !== APP_UPGRADE_PENDING_RELOAD) {
    dispatch(showSuccess(signoutSuccess));
  }
};

export default signout;
