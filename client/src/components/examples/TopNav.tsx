import TopNav from "../TopNav";

export default function TopNavExample() {
  return (
    <TopNav
      unreadMessages={3}
      unreadNotifications={5}
      onMenuClick={() => console.log("Menu clicked")}
      onSearchChange={(value) => console.log("Search:", value)}
      onMessagesClick={() => console.log("Messages clicked")}
      onNotificationsClick={() => console.log("Notifications clicked")}
      onProfileClick={() => console.log("Profile clicked")}
    />
  );
}
